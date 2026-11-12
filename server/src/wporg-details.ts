import type { WporgBlock, WporgChangelogVersion, WporgDetails, WporgInline } from '@devmagic-panel/shared';
import { wpSlug } from '@devmagic-panel/shared';
import type { RunStore } from './store.js';
import type { FetchJson } from './wporg-plugins.js';

/**
 * A plugin's or theme's details from WordPress.org, for the dialog wp-admin calls "View version
 * details": the facts (versions it needs and was tested with, installs, rating) and its changelog,
 * description, installation and FAQ. Asked by slug only, never a version or a site's name, when
 * you open the dialog, and kept six hours in the panel's database. The sections come as HTML: they
 * are read here into a few kinds of block (paragraphs, headings, lists, preformatted text) with
 * bold, italic, code and http(s) links, so no HTML of WordPress.org's ever reaches the browser.
 */

const KEEP_MS = 6 * 3_600_000;
/** More than any readme needs; a bigger section is cut, not refused. */
const MAX_HTML = 400_000;
const MAX_BLOCKS = 600;
const MAX_VERSIONS = 40;

const fetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'devmagic-panel' } });
  return { status: res.status, body: res.ok ? ((await res.json()) as unknown) : null };
};

export const wporgDetailsUrl = (kind: 'plugin' | 'theme', slug: string) =>
  kind === 'plugin'
    ? `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(slug)}&request[fields][sections]=1&request[fields][versions]=0&request[fields][screenshots]=0&request[fields][reviews]=0&request[fields][banners]=0&request[fields][icons]=0`
    : `https://api.wordpress.org/themes/info/1.2/?action=theme_information&request[slug]=${encodeURIComponent(slug)}&request[fields][sections]=1&request[fields][description]=1&request[fields][active_installs]=1&request[fields][rating]=1&request[fields][num_ratings]=1&request[fields][last_updated]=1&request[fields][versions]=0`;

export class WporgDetailsMissing extends Error {}

export async function wporgDetails(kind: 'plugin' | 'theme', slug: string, store: Pick<RunStore, 'getMeta' | 'setMeta'>, fetcher: FetchJson = fetchJson, now = Date.now()): Promise<WporgDetails> {
  if (!wpSlug.safeParse(slug).success) throw new WporgDetailsMissing('Not a slug WordPress.org has');
  const key = `wporg-details:${kind}:${slug}`;
  try {
    const kept = JSON.parse(store.getMeta(key) ?? 'null') as { at: number; details: WporgDetails } | null;
    if (kept && now - kept.at < KEEP_MS) return kept.details;
  } catch {
    // read again
  }
  const { status, body } = await fetcher(wporgDetailsUrl(kind, slug));
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b.version !== 'string' || b.slug !== slug) {
    throw new WporgDetailsMissing(status === 404 || (b && typeof b.error === 'string') ? `WordPress.org has no ${kind} called ${slug}` : `WordPress.org did not answer (${status})`);
  }
  const details = readDetails(kind, slug, b, new Date(now).toISOString());
  store.setMeta(key, JSON.stringify({ at: now, details }));
  return details;
}

const str = (v: unknown, max = 60): string | undefined => (typeof v === 'string' && v.trim() !== '' ? decodeEntities(v.replace(/<[^>]*>/g, '')).trim().slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The details from WordPress.org's answer: only the fields the dialog shows, each checked. */
export function readDetails(kind: 'plugin' | 'theme', slug: string, b: Record<string, unknown>, readAt: string): WporgDetails {
  const sections = (b.sections && typeof b.sections === 'object' ? b.sections : {}) as Record<string, unknown>;
  const section = (name: string) => (typeof sections[name] === 'string' ? htmlBlocks(sections[name] as string) : []);
  const opt = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : ({ [k]: v } as Record<K, V>));
  return {
    kind,
    slug,
    name: str(b.name, 200) ?? slug,
    version: str(b.version, 40) ?? '',
    ...opt('requires', str(b.requires, 20)),
    ...opt('tested', str(b.tested, 20)),
    ...opt('requiresPhp', str(b.requires_php, 20)),
    ...opt('lastUpdated', str(b.last_updated, 40)),
    ...opt('activeInstalls', num(b.active_installs)),
    ...opt('rating', num(b.rating)),
    ...opt('numRatings', num(b.num_ratings)),
    page: `https://wordpress.org/${kind}s/${slug}/`,
    changelog: changelogVersions(section('changelog')),
    // A theme's description comes as its own field when its sections have none.
    description: section('description').length ? section('description') : typeof b.description === 'string' ? htmlBlocks(b.description) : [],
    installation: section('installation'),
    faq: section('faq'),
    readAt,
  };
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', bull: '*', middot: '·', copy: '©', reg: '®', trade: '™', times: '×', rarr: '->', larr: '<-' };

/** HTML entities to their characters: the named ones readmes use, and every numbered one. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      // A dash or a quote WordPress made typographic reads as the plain one.
      if (n === 8211 || n === 8212) return '-';
      if (n === 8216 || n === 8217) return "'";
      if (n === 8220 || n === 8221) return '"';
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

/** Tags whose content is never text to show. */
const DROP = new Set(['script', 'style', 'iframe', 'svg', 'noscript', 'object', 'embed', 'form', 'button', 'select', 'textarea', 'template', 'video', 'audio', 'canvas']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'blockquote', 'dd', 'dt', 'dl', 'table', 'tr', 'figure', 'figcaption', 'header', 'footer']);

/**
 * WordPress.org's HTML read into blocks: paragraphs, headings, lists (a list inside a list adds its
 * items to the outer one), preformatted text, and in them bold, italic, code and http(s) links.
 * Every other tag is left out and its text kept; scripts, styles, frames and forms are left out
 * with their text. Images are left out.
 */
export function htmlBlocks(html: string): WporgBlock[] {
  const source = html.slice(0, MAX_HTML);
  const blocks: WporgBlock[] = [];
  let para: { kind: 'p' | 'h'; parts: WporgInline[] } | null = null;
  let list: { kind: 'ul' | 'ol'; items: WporgInline[][] } | null = null;
  let listDepth = 0;
  let item: WporgInline[] | null = null;
  let pre: string | null = null;
  let dropping: { tag: string; depth: number } | null = null;
  let bold = 0;
  let italic = 0;
  let code = 0;
  const links: Array<string | undefined> = [];

  const push = (block: WporgBlock) => {
    if (blocks.length < MAX_BLOCKS) blocks.push(block);
  };
  const tidy = (parts: WporgInline[]): WporgInline[] => {
    const out: WporgInline[] = [];
    for (const p of parts) {
      const last = out.at(-1);
      if (last && last.bold === p.bold && last.italic === p.italic && last.code === p.code && last.href === p.href) last.text += p.text;
      else out.push({ ...p });
    }
    // No space at either end, nor around a line break.
    if (out[0]) out[0].text = out[0].text.replace(/^\s+/, '');
    const end = out.at(-1);
    if (end) end.text = end.text.replace(/\s+$/, '');
    for (const p of out) p.text = p.text.replace(/ *\n */g, '\n');
    return out.filter((p) => p.text !== '');
  };
  const endPara = () => {
    if (para) {
      const parts = tidy(para.parts);
      if (parts.length) push({ kind: para.kind, parts });
    }
    para = null;
  };
  const endItem = () => {
    if (item && list) {
      const parts = tidy(item);
      if (parts.length) list.items.push(parts);
    }
    item = null;
  };
  const endList = () => {
    endItem();
    if (list && list.items.length) push(list);
    list = null;
    listDepth = 0;
  };
  const addText = (raw: string) => {
    const text = decodeEntities(raw).replace(/\s+/g, ' ');
    if (text === '' || (text === ' ' && !item && !para)) return;
    const href = links.at(-1);
    const part: WporgInline = { text, ...(bold ? { bold: true as const } : {}), ...(italic ? { italic: true as const } : {}), ...(code ? { code: true as const } : {}), ...(href ? { href } : {}) };
    if (list) {
      if (!item) item = [];
      item.push(part);
      return;
    }
    if (!para) para = { kind: 'p', parts: [] };
    para.parts.push(part);
  };
  const lineBreak = () => {
    if (list && item) item.push({ text: '\n' });
    else if (para) para.parts.push({ text: '\n' });
  };

  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)|</g;
  for (let m = token.exec(source); m; m = token.exec(source)) {
    const [whole, close, rawTag, attrs, text] = m;
    if (whole.startsWith('<!--')) continue;
    if (text !== undefined || whole === '<') {
      const t = text ?? '<';
      if (dropping) continue;
      if (pre !== null) pre += decodeEntities(t);
      else addText(t);
      continue;
    }
    const tag = (rawTag as string).toLowerCase();
    if (dropping) {
      if (tag === dropping.tag) dropping.depth += close ? -1 : whole.endsWith('/>') ? 0 : 1;
      if (dropping.depth <= 0) dropping = null;
      continue;
    }
    if (DROP.has(tag)) {
      if (!close && !whole.endsWith('/>')) dropping = { tag, depth: 1 };
      continue;
    }
    if (pre !== null) {
      if (tag === 'pre' && close) {
        const t = pre.replace(/^\n+|\s+$/g, '');
        if (t) push({ kind: 'pre', text: t.slice(0, 20_000) });
        pre = null;
      } else if (tag === 'br') pre += '\n';
      continue;
    }
    if (tag === 'pre' && !close) {
      endPara();
      endList();
      pre = '';
    } else if (/^h[1-6]$/.test(tag)) {
      endList();
      endPara();
      if (!close) para = { kind: 'h', parts: [] };
    } else if (tag === 'ul' || tag === 'ol') {
      if (!close) {
        endPara();
        if (!list) list = { kind: tag, items: [] };
        else endItem();
        listDepth += 1;
      } else {
        listDepth -= 1;
        if (listDepth <= 0) endList();
        else endItem();
      }
    } else if (tag === 'li') {
      if (!list) {
        endPara();
        list = { kind: 'ul', items: [] };
        listDepth = 1;
      }
      endItem();
      if (!close) item = [];
    } else if (BLOCK.has(tag)) {
      if (list) {
        if (close) lineBreak();
      } else {
        endPara();
      }
    } else if (tag === 'br') {
      lineBreak();
    } else if (tag === 'strong' || tag === 'b') {
      bold = Math.max(0, bold + (close ? -1 : 1));
    } else if (tag === 'em' || tag === 'i') {
      italic = Math.max(0, italic + (close ? -1 : 1));
    } else if (tag === 'code' || tag === 'kbd' || tag === 'tt') {
      code = Math.max(0, code + (close ? -1 : 1));
    } else if (tag === 'a') {
      if (close) links.pop();
      else {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs ?? '');
        const url = decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
        links.push(/^https?:\/\/[^\s]+$/i.test(url) && url.length <= 2000 ? url : undefined);
      }
    }
  }
  if (pre !== null && (pre as string).trim()) push({ kind: 'pre', text: (pre as string).trim().slice(0, 20_000) });
  endList();
  endPara();
  return blocks;
}

const plain = (parts: WporgInline[]) => parts.map((p) => p.text).join('').trim();
/** A version number at the start of a heading: 1.0.280, v2.3, Version 4.1.2-beta, 5.0 (2026-11-10). */
const VERSION_HEAD = /^(?:version\s+)?v?(\d+(?:\.\d+)+(?:[-+.]?[0-9a-z]+)*)\b\s*(.*)$/i;

/**
 * A changelog cut into its versions. A heading that starts with a version number starts one, as
 * does a short paragraph that is all bold or is only a version and a date: the shapes readmes
 * give their changelogs (`= 1.2.3 =` becomes a heading on WordPress.org). What follows, up to the
 * next, is that version's.
 */
export function changelogVersions(blocks: WporgBlock[]): WporgChangelogVersion[] {
  const out: WporgChangelogVersion[] = [];
  let current: WporgChangelogVersion | null = null;
  for (const block of blocks) {
    if (block.kind === 'p' || block.kind === 'h') {
      const text = plain(block.parts);
      const m = VERSION_HEAD.exec(text);
      const rest = m?.[2]?.replace(/^[\s:(\-–—=|,]+|[\s)=]+$/g, '') ?? '';
      const head = m && text.length <= 80 && (block.kind === 'h' || block.parts.every((p) => p.bold || p.text.trim() === '') || rest.length <= 40 && !/[a-z]{4,}\s+[a-z]{4,}/i.test(rest));
      if (m && head) {
        if (out.length >= MAX_VERSIONS) break;
        current = { version: m[1] as string, ...(rest ? { note: rest.slice(0, 60) } : {}), blocks: [] };
        out.push(current);
        continue;
      }
    }
    if (!current) {
      current = { version: '', blocks: [] };
      out.push(current);
    }
    current.blocks.push(block);
  }
  return out.filter((v) => v.version !== '' || v.blocks.length > 0);
}

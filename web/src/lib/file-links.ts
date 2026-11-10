import { isSitePath } from '@devmagic-panel/shared';
import { siteHref } from './site-ref.js';

type SiteId = { domain: string; path?: string };

/** A place in a site's Files tab: a folder, or a file and a line in it, open to read or to edit. */
export function filesHref(site: SiteId, at: { dir?: string; file?: string; line?: number; edit?: boolean } = {}): string {
  const query = at.file !== undefined ? `&file=${encodeURIComponent(at.file)}${at.line ? `&line=${at.line}` : ''}${at.edit ? '&edit=1' : ''}` : at.dir ? `&dir=${encodeURIComponent(at.dir)}` : '';
  return `${siteHref(site)}?tab=files${query}`;
}

export interface FileMention {
  /** Where the mention starts and ends in the text. */
  start: number;
  end: number;
  /** The file, relative to the site's folder. */
  file: string;
  line?: number;
}

// A path with an extension, then how PHP and stack traces name the line: "on line 12", ":12" or "(12)".
const MENTION = /(\/[^\s:()'"]+\.[A-Za-z0-9]{1,5})(?: on line (\d+)|:(\d+)|\((\d+)\))?/g;

/** The files under a site's folder that a log line names, like /var/www/site/wp-content/x.php on line 12. */
export function fileMentions(text: string, docroot: string): FileMention[] {
  const root = docroot.replace(/\/+$/, '');
  if (!root) return [];
  const found: FileMention[] = [];
  for (const m of text.matchAll(MENTION)) {
    const path = m[1] as string;
    if (!path.startsWith(`${root}/`)) continue;
    const file = path.slice(root.length + 1);
    if (!isSitePath(file)) continue;
    const line = Number(m[2] ?? m[3] ?? m[4] ?? 0);
    found.push({ start: m.index, end: m.index + m[0].length, file, ...(line > 0 ? { line } : {}) });
  }
  return found;
}

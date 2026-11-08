import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HtaccessFile, HtaccessReport, HtaccessRule, HtaccessRuleStatus } from '@devmagic-panel/shared';
import { scanHtaccess } from './htaccess.js';

/**
 * A site's .htaccess files read for nginx: each rule sorted into what nginx
 * does already, what the panel translates, what is not needed on this
 * computer, PHP settings, and what it does not translate. A translated rule
 * is one of the kinds dmp-root takes (scripts/lib/nginx.sh, "# .htaccess
 * rules on nginx"); the checks here mirror dmp-root's, which checks again.
 */

/** As DMP_NGINX_MAX_RULES: the most rules one nginx file takes. */
export const MAX_RULES = 500;

/** As DMP_NGINX_HEADERS: the headers a rule may set or unset, by lowercase name. */
const HEADERS = new Map(
  [
    'X-Frame-Options', 'X-Content-Type-Options', 'X-XSS-Protection', 'Referrer-Policy', 'Strict-Transport-Security',
    'Content-Security-Policy', 'Content-Security-Policy-Report-Only', 'Permissions-Policy', 'Cross-Origin-Opener-Policy',
    'Cross-Origin-Embedder-Policy', 'Cross-Origin-Resource-Policy', 'Access-Control-Allow-Origin', 'Access-Control-Allow-Methods',
    'Access-Control-Allow-Headers', 'Access-Control-Allow-Credentials', 'Access-Control-Expose-Headers', 'X-Robots-Tag', 'X-Powered-By',
  ].map((h) => [h.toLowerCase(), h]),
);
/** Headers about caching, which a local copy does without. */
const CACHE_HEADERS = new Set(['cache-control', 'expires', 'pragma', 'etag', 'vary', 'last-modified', 'age']);

const REGEX_CHARS = /^[\][A-Za-z0-9/._~%^$*+?()|\\,=:@!&-]+$/;
/** As dmp_nginx_regex_ok: nginx takes it unquoted, with no backslash pair it would read as its own escape. */
export const regexOk = (r: string) => r.length <= 512 && REGEX_CHARS.test(r) && !/\\\\|\\[trn]|\\$/.test(r);

const TARGET_CHARS = /^(https?:\/\/[a-z0-9.$_-]+(:[0-9]{1,5})?)?(\/[A-Za-z0-9/._~%?&=+:@!,()*$-]*)?$/;
/** As dmp_nginx_target_ok: a path or an http(s) address, with only $1 to $9 and a few nginx variables. */
export const targetOk = (t: string) =>
  t.length > 0 && t.length <= 1024 && TARGET_CHARS.test(t) && /^(\/|https?:\/\/)/.test(t) && !t.replace(/\$([1-9]|host|scheme|request_uri|args|is_args)/g, '').includes('$');

const headerValueOk = (v: string) => v.length > 0 && v.length <= 1024 && /^[ -~]+$/.test(v) && !/["\\$]/.test(v);

/** What a rule becomes in the site's nginx file, as dmp_nginx_rules_render writes it. */
export function ruleNginx(rule: string): string {
  const [kind, a = '', b = '', ...rest] = rule.split(' ');
  if (kind === 'redirect') return `rewrite ${b} ${rest.join(' ')} ${a === '301' ? 'permanent' : 'redirect'};`;
  if (kind === 'rewrite') return `rewrite ${a} ${b} last;`;
  if (kind === 'deny') return `location ~ ${a} { deny all; }`;
  if (kind === 'error-page') return `error_page ${a} ${b};`;
  if (kind === 'header') return a === 'set' ? `add_header ${b} "${rest.join(' ')}" always;` : `fastcgi_hide_header ${b};`;
  return '';
}

/** Escapes a literal path for a regex. */
const literal = (s: string) => s.replace(/[.+*?()[\]^$|\\]/g, (c) => `\\${c}`);

/** Apache's arguments: words, or "quoted" ones. */
function words(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : (m[2] ?? m[3] ?? ''));
  return out;
}

type Verdict = { status: HtaccessRuleStatus; note?: string; rule?: string };
const covered = (note: string): Verdict => ({ status: 'covered', note });
const local = (note: string): Verdict => ({ status: 'local', note });
const manual = (note: string): Verdict => ({ status: 'manual', note });
/** A translated rule, once its fields pass dmp-root's checks. */
const translated = (rule: string, note?: string): Verdict => ({ status: 'translated', rule, ...(note ? { note } : {}) });

const CACHING = 'Caching and compression: not needed on this computer';
const CACHE_SECTION = /cache|w3tc|rocket|litespeed|expires|gzip|deflate|compress|autoptimize|hummingbird|fastest|breeze|swift|perfmatters|sg optimizer/i;
const CACHE_DIRECTIVES = new Set(['expiresactive', 'expiresbytype', 'expiresdefault', 'fileetag', 'addoutputfilterbytype', 'setoutputfilter', 'addencoding', 'deflatecompressionlevel', 'browsermatch', 'browsermatchnocase', 'header-cache']);

interface Context {
  /** The folder's URL path with a slash at the end: / for the site's own .htaccess. */
  prefix: string;
  /** RewriteBase, or the folder's path. */
  base: string;
}

/** A deny rule for the whole folder, or for files in it and below (a <Files> pattern as a regex on the file name). */
function denyFolder(ctx: Context): Verdict {
  if (ctx.prefix === '/') return manual("Denies every visitor the whole site; the panel leaves that to you");
  return checked(`deny ^${literal(ctx.prefix)}`, 'nginx denies this folder');
}

/** A rule whose fields pass dmp-root's checks; else what keeps it from nginx. */
function checked(rule: string, note?: string): Verdict {
  const [kind, a = '', b = '', c = ''] = rule.split(' ');
  const ok =
    kind === 'redirect' ? regexOk(b) && targetOk(c) && rule.split(' ').length === 4
    : kind === 'rewrite' ? regexOk(a) && targetOk(b) && b.startsWith('/') && rule.split(' ').length === 3
    : kind === 'deny' ? regexOk(a) && rule.split(' ').length === 2
    : false;
  return ok ? translated(rule, note) : manual('Has characters the panel does not pass to nginx');
}

/** RewriteRule with the RewriteCond lines before it. */
function rewriteRule(args: string[], conds: string[][], ctx: Context): Verdict {
  const [pattern, target, flagText] = args;
  if (!pattern || !target) return manual('An incomplete RewriteRule');
  const flags = new Map<string, string>();
  for (const f of (flagText ?? '').replace(/^\[|\]$/g, '').split(',').filter(Boolean)) {
    const [k = '', v = ''] = f.split('=');
    flags.set(k.trim().toLowerCase(), v.trim());
  }
  const env = flags.get('e') ?? flags.get('env');
  if (env !== undefined) {
    return /^HTTP_AUTHORIZATION:/i.test(env) ? covered("nginx passes the Authorization header to PHP") : manual('Sets an environment variable');
  }
  const known = new Set(['l', 'last', 'r', 'redirect', 'nc', 'nocase', 'qsa', 'qsappend', 'qsd', 'qsdiscard', 'ne', 'noescape', 'f', 'forbidden', 'end']);
  const unknown = [...flags.keys()].filter((k) => !known.has(k));
  if (unknown.length) return manual(`Uses the [${unknown.map((k) => k.toUpperCase()).join(',')}] flag, which the panel does not translate`);

  const vars = conds.map((c) => (c[0] ?? '').toUpperCase());
  const https = (c: string[]) => /^%\{(HTTPS|SERVER_PORT|HTTP:X-FORWARDED-PROTO|REQUEST_SCHEME)\}$/i.test(c[0] ?? '');
  if (conds.length && conds.every(https)) return covered('nginx sends http to https already');
  if (conds.some((c) => /^%\{HTTP_HOST\}$/i.test(c[0] ?? '')) && conds.every((c) => https(c) || /^%\{HTTP_HOST\}$/i.test(c[0] ?? ''))) {
    return local("Names the production hosts; here the site answers to its own names");
  }
  const fileCheck = (c: string[]) => /^%\{REQUEST_FILENAME\}$/i.test(c[0] ?? '') && /^!-[fdl]$/.test(c[1] ?? '');
  if (conds.length && conds.every(fileCheck) && /(^|\/)index\.php$/.test(target)) return covered("WordPress's own rule: nginx sends missing files to index.php");
  if (conds.length) return manual(`Depends on ${[...new Set(vars)].join(', ')}, which the panel does not translate`);

  if (pattern.startsWith('!')) return manual('A negated pattern');
  if (/^\^\/(?!\?)/.test(pattern)) return manual('Never matches: in an .htaccess the path has no leading slash');
  if (/(^|\/)index\\?\.php\$?$/.test(pattern.replace(/^\^/, '')) && target === '-') return covered("WordPress's own rule");

  let p = pattern;
  const anchored = p.startsWith('^');
  if (anchored) p = p.slice(1);
  if (p.startsWith('/?')) p = p.slice(2);
  let regex = anchored ? `^${literal(ctx.prefix)}${p}` : ctx.prefix === '/' ? p : `^${literal(ctx.prefix)}.*${p}`;
  if (flags.has('nc') || flags.has('nocase')) regex = `(?i)${regex}`;

  if (target === '-') {
    if (flags.has('f') || flags.has('forbidden')) return checked(`deny ${regex}`, 'nginx denies it');
    return covered('Stops later rules; nginx serves the file as it is');
  }
  if (flags.has('f') || flags.has('forbidden')) return checked(`deny ${regex}`, 'nginx denies it');
  if (/%[0-9]/.test(target)) return manual('Uses a part of a RewriteCond');
  let t = target
    .replace(/%\{HTTP_HOST\}/gi, '$host')
    .replace(/%\{REQUEST_URI\}/gi, '$request_uri')
    .replace(/%\{QUERY_STRING\}/gi, '$args');
  if (/%\{/.test(t)) return manual('Uses a server variable the panel does not translate');
  const absolute = /^https?:\/\//.test(t);
  if (!absolute && !t.startsWith('/')) t = `${ctx.base}${t}`;
  // nginx adds the request's arguments unless the target ends with ?; Apache drops them when the target has its own, without [QSA].
  const qsa = flags.has('qsa') || flags.has('qsappend');
  if (flags.has('qsd') || flags.has('qsdiscard') || (t.includes('?') && !qsa)) t = `${t}?`;

  const r = flags.get('r') ?? flags.get('redirect');
  if (r !== undefined || absolute) {
    const code = r === undefined || r === '' || /^(302|temp)$/i.test(r) ? '302' : /^(301|permanent)$/i.test(r) ? '301' : null;
    if (!code) return manual(`A ${r} redirect, which the panel does not translate (301 and 302 only)`);
    return checked(`redirect ${code} ${regex} ${t}`);
  }
  return checked(`rewrite ${regex} ${t}`);
}

/** Redirect, RedirectMatch, RedirectPermanent, RedirectTemp. */
function redirect(name: string, args: string[]): Verdict {
  const rest = [...args];
  let status: string | undefined = name === 'redirectpermanent' ? '301' : name === 'redirecttemp' ? '302' : undefined;
  if (!status && /^(permanent|temp|seeother|gone|\d{3})$/i.test(rest[0] ?? '')) status = rest.shift();
  const code = !status || /^(302|temp)$/i.test(status) ? '302' : /^(301|permanent)$/i.test(status) ? '301' : null;
  if (!code) return manual(`A ${status} redirect, which the panel does not translate (301 and 302 only)`);
  const [from, to] = rest;
  if (!from || !to) return manual('An incomplete redirect');
  if (name === 'redirectmatch') return checked(`redirect ${code} ${from} ${to}`);
  // Redirect sends the path and everything below it, with the rest of the path kept.
  const base = from.replace(/\/+$/, '');
  return from.endsWith('/')
    ? checked(`redirect ${code} ^${literal(from)}(.*)$ ${to.endsWith('/') ? to : `${to}/`}$1`)
    : checked(`redirect ${code} ^${literal(base)}(/.*)?$ ${to.replace(/\/+$/, '')}$1`);
}

/** Header [always] set|unset Name [value] [condition]. */
function header(args: string[]): Verdict {
  const rest = [...args];
  if (/^(always|onsuccess)$/i.test(rest[0] ?? '')) rest.shift();
  const [action = '', name = '', value, extra] = rest;
  const lower = name.toLowerCase();
  if (CACHE_HEADERS.has(lower)) return local(CACHING);
  if (extra !== undefined || (value !== undefined && /^(env|expr)=/i.test(value) && action.toLowerCase() === 'unset')) return manual('Only under a condition, which the panel does not translate');
  const canonical = HEADERS.get(lower);
  if (!canonical) return manual(`A header the panel does not set on nginx: ${name}`);
  if (/^unset$/i.test(action)) return translated(`header unset ${canonical}`);
  if (!/^(set|setifempty)$/i.test(action)) return manual(`Header ${action}, which the panel does not translate (set and unset only)`);
  if (!value || !headerValueOk(value)) return manual('A header value the panel does not pass to nginx');
  return translated(`header set ${canonical} ${value}`);
}

/** What a <Files> or <FilesMatch> block is: its access rule as a deny of matching files, or caching. */
function filesBlock(tag: string, arg: string, body: string[], ctx: Context): Verdict {
  const lines = body.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const deny = lines.some((l) => /^(Require\s+all\s+denied|Deny\s+from\s+all)\b/i.test(l));
  const grant = lines.length > 0 && lines.every((l) => /^(Require\s+all\s+granted|Allow\s+from\s+all|Order\s+|Satisfy\s+|<\/?IfModule)/i.test(l));
  const caching = lines.length > 0 && lines.every((l) => CACHE_DIRECTIVES.has((l.split(/\s+/)[0] ?? '').toLowerCase()) || /^Header\s+/i.test(l) || /^<\/?IfModule/i.test(l));
  if (!deny) return grant ? covered('Allows every visitor, as nginx does') : caching ? local(CACHING) : manual(`A <${tag}> block with rules the panel does not translate`);
  const [first = '', second] = words(arg);
  const isRegex = tag.toLowerCase() === 'filesmatch' || first === '~';
  const pattern = first === '~' ? second ?? '' : first;
  if (!pattern) return manual(`An incomplete <${tag}> block`);
  const within = `^${literal(ctx.prefix)}(?:.*/)?`;
  let regex: string;
  if (isRegex) {
    regex = pattern.startsWith('^') ? `${within}${pattern.slice(1)}` : `${within}[^/]*${pattern}`;
    if (!regex.endsWith('$')) regex += '[^/]*$';
  } else {
    regex = `${within}${literal(pattern).replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '[^/]')}$`;
  }
  return checked(`deny ${regex}`, lines.length > 1 && !lines.every((l) => /^(Require|Deny|Order|Allow|Satisfy)\b/i.test(l)) ? 'Only its access rule is translated' : 'nginx denies the matching files');
}

/** One directive outside RewriteRule and blocks. */
function directive(name: string, args: string[], line: string, ctx: Context): Verdict {
  switch (name) {
    case 'rewriteengine':
    case 'rewriteoptions':
      return covered('nginx rewrites without it');
    case 'rewritebase':
      return covered('Used for the rules below it');
    case 'options':
      return /\+Indexes|^Indexes|\s+Indexes/.test(args.join(' ')) && !/-Indexes/.test(args.join(' ')) ? manual('Lists folder contents, which nginx does not') : covered("nginx's default: no folder listings, links followed");
    case 'directoryindex':
      return args.some((a) => /^index\.(php|html?)$/.test(a)) ? covered('nginx tries index.php and index.html') : manual('Another index file');
    case 'serversignature':
    case 'adddefaultcharset':
    case 'satisfy':
    case 'addtype':
    case 'addcharset':
      return covered(name === 'addtype' || name === 'addcharset' ? "nginx knows file types from its mime.types" : 'Nothing to do on nginx');
    case 'order':
      return covered('Only orders the Allow and Deny lines');
    case 'require':
      if (/^all\s+denied$/i.test(args.join(' '))) return denyFolder(ctx);
      if (/^all\s+granted$/i.test(args.join(' '))) return covered('Allows every visitor, as nginx does');
      return manual('Limits who may visit, which the panel does not translate');
    case 'deny':
      return /^from\s+all$/i.test(args.join(' ')) ? denyFolder(ctx) : manual('Limits who may visit, which the panel does not translate');
    case 'allow':
      return /^from\s+all$/i.test(args.join(' ')) ? covered('Allows every visitor, as nginx does') : manual('Limits who may visit, which the panel does not translate');
    case 'redirect':
    case 'redirectmatch':
    case 'redirectpermanent':
    case 'redirecttemp':
      return redirect(name, args);
    case 'errordocument': {
      const [code = '', target = ''] = args;
      if (/^[45]\d\d$/.test(code) && /^\/[A-Za-z0-9/._-]*$/.test(target)) return translated(`error-page ${code} ${target}`);
      return manual('An error page that is text or another address');
    }
    case 'header':
      return header(args);
    case 'php_value':
    case 'php_flag':
    case 'php_admin_value':
    case 'php_admin_flag':
      return { status: 'php', note: `${args[0] ?? ''} = ${args.slice(1).join(' ')}: set it on the PHP tab, as nginx runs PHP through PHP-FPM` };
    default:
      if (CACHE_DIRECTIVES.has(name)) return local(CACHING);
      if (/^(addhandler|sethandler|action|forcetype|removehandler)$/.test(name)) return manual('Runs files through a handler of its own');
      if (/^(setenv|setenvif|setenvifnocase|unsetenv|passenv)$/.test(name)) return manual('Sets an environment variable');
      return manual(`${line.split(/\s+/)[0]} is not translated`);
  }
}

interface Logical {
  n: number;
  text: string;
}

/** The file's lines with line continuations joined, each with its first line number. */
function logicalLines(text: string): Logical[] {
  const out: Logical[] = [];
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < raw.length; i++) {
    const n = i + 1;
    let line = raw[i] ?? '';
    while (line.endsWith('\\') && i + 1 < raw.length) line = `${line.slice(0, -1)} ${(raw[++i] ?? '').trim()}`;
    out.push({ n, text: line.trim() });
  }
  return out;
}

/** The rules of one .htaccess, in the folder (URL path) it is in. */
export function translateHtaccess(folder: string, text: string): HtaccessRule[] {
  const prefix = folder === '/' ? '/' : `${folder}/`;
  const ctx: Context = { prefix, base: prefix };
  const lines = logicalLines(text);
  const rules: HtaccessRule[] = [];
  const seen = new Map<string, number>();
  let section: string | undefined;
  let conds: Logical[] = [];
  const negated: boolean[] = [];

  const add = (first: Logical, source: string, verdict: Verdict) => {
    const key = createHash('sha1').update(`${folder}\n${source}`).digest('hex').slice(0, 12);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    const rule: HtaccessRule = { id: count ? `${key}-${count}` : key, file: folder, line: first.n, source, status: verdict.status };
    if (section) rule.section = section;
    if (verdict.note) rule.note = verdict.note;
    if (verdict.rule) {
      rule.rule = verdict.rule;
      rule.nginx = ruleNginx(verdict.rule);
    }
    rules.push(rule);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Logical;
    const t = line.text;
    if (!t) continue;
    if (t.startsWith('#')) {
      const begin = /^#\s*BEGIN\s+(.+)$/.exec(t)?.[1]?.trim();
      if (begin) {
        // WordPress's section, and caching plugins' sections, are one rule each.
        const wordpress = /^WordPress\b/i.test(begin);
        if (wordpress || CACHE_SECTION.test(begin)) {
          let end = i + 1;
          while (end < lines.length && !/^#\s*END\b/.test(lines[end]?.text ?? '')) end++;
          const body = lines.slice(i, Math.min(end + 1, lines.length)).map((l) => l.text).filter(Boolean);
          section = begin;
          add(line, body.join('\n'), wordpress ? covered("WordPress's own rules: the nginx file has them") : local(CACHING));
          section = undefined;
          i = end;
          continue;
        }
        section = begin;
      } else if (/^#\s*END\b/.test(t)) section = undefined;
      continue;
    }

    const open = /^<([A-Za-z]+)(\s+[^>]*)?>$/.exec(t);
    if (open) {
      const tag = open[1] as string;
      const arg = (open[2] ?? '').trim();
      if (/^IfModule$/i.test(tag)) {
        negated.push(arg.startsWith('!'));
        continue;
      }
      // Any other block: up to its own closing tag, nested ones of the same name counted.
      let depth = 1;
      let end = i + 1;
      for (; end < lines.length; end++) {
        const inner = lines[end]?.text ?? '';
        if (new RegExp(`^<${tag}(\\s|>)`, 'i').test(inner)) depth++;
        if (new RegExp(`^</${tag}\\s*>`, 'i').test(inner) && --depth === 0) break;
      }
      const body = lines.slice(i + 1, end).map((l) => l.text);
      const source = lines.slice(i, Math.min(end + 1, lines.length)).map((l) => l.text).filter(Boolean).join('\n');
      if (negated.some(Boolean)) add(line, source, covered('Only for Apache without that module'));
      else if (/^Files(Match)?$/i.test(tag)) add(line, source, filesBlock(tag, arg, body, ctx));
      else add(line, source, manual(`A <${tag}> block, which the panel does not translate`));
      i = end;
      continue;
    }
    if (/^<\/IfModule\s*>$/i.test(t)) {
      negated.pop();
      continue;
    }

    const [first = '', ...rest] = words(t);
    const name = first.toLowerCase();
    if (name === 'rewritecond') {
      conds.push(line);
      continue;
    }
    if (negated.some(Boolean)) {
      add(conds[0] ?? line, [...conds, line].map((l) => l.text).join('\n'), covered('Only for Apache without that module'));
      conds = [];
      continue;
    }
    if (name === 'rewritebase' && rest[0]?.startsWith('/')) ctx.base = rest[0].endsWith('/') ? rest[0] : `${rest[0]}/`;
    if (name === 'rewriterule') {
      const condWords = conds.map((c) => words(c.text).slice(1));
      add(conds[0] ?? line, [...conds, line].map((l) => l.text).join('\n'), rewriteRule(rest, condWords, ctx));
      conds = [];
      continue;
    }
    add(line, t, directive(name, rest, t, ctx));
  }
  return rules;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Every .htaccess of a site, read and translated. For a site on nginx,
 * `applied` is what its nginx file has: the report then says whether a file
 * changed since.
 */
export function readHtaccessReport(docroot: string, applied?: { rules: string[]; sums: Record<string, string> }, now = Date.now(), fresh = false): HtaccessReport {
  const scan = scanHtaccess(docroot, fresh);
  const folders = [...(existsSync(join(docroot, '.htaccess')) ? ['/'] : []), ...scan.folders];
  const files: HtaccessFile[] = [];
  const rules: HtaccessRule[] = [];
  let partial = scan.partial;
  for (const folder of folders) {
    let text: string;
    try {
      text = readFileSync(join(docroot, folder === '/' ? '' : folder, '.htaccess'), 'utf8');
    } catch {
      continue;
    }
    files.push({ folder, sha256: sha256(text) });
    rules.push(...translateHtaccess(folder, text));
  }
  // dmp-root takes so many rules: the rest stay out, and the report says so.
  let count = 0;
  for (const rule of rules) {
    if (rule.status !== 'translated') continue;
    if (++count > MAX_RULES) {
      rule.status = 'manual';
      rule.note = `More than ${MAX_RULES} rules: the panel stops here`;
      delete rule.rule;
      delete rule.nginx;
      partial = true;
    }
  }
  const report: HtaccessReport = {
    checkedAt: new Date(now).toISOString(),
    files,
    rules,
    nginx: rules.filter((r) => r.nginx).map((r) => r.nginx).join('\n'),
    ...(partial ? { partial } : {}),
  };
  if (applied) {
    report.applied = applied;
    const current = Object.fromEntries(files.map((f) => [f.folder, f.sha256]));
    const recorded = Object.keys(applied.sums).length > 0;
    report.changed = recorded ? !sameSums(current, applied.sums) : rules.some((r) => r.status === 'translated');
  }
  return report;
}

/** True when two sets of checksums name the same files with the same contents. */
export function sameSums(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** The rules to apply from a report: the translated ones, but those left out, without repeats. */
export function chosenRules(report: HtaccessReport, skip: string[] = []): string[] {
  const out: string[] = [];
  for (const r of report.rules) if (r.status === 'translated' && r.rule && !skip.includes(r.id) && !out.includes(r.rule)) out.push(r.rule);
  return out;
}

/** The checksums of a report's files, by folder. */
export const reportSums = (report: HtaccessReport): Record<string, string> => Object.fromEntries(report.files.map((f) => [f.folder, f.sha256]));

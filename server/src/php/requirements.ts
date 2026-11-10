import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { themeFolders } from '../sites/local-mode.js';

/**
 * The lowest PHP a site's code asks for: composer.json's require.php, the
 * `Requires PHP:` header of its themes and plugins, and the minimum of its
 * WordPress. The highest of those minimums is what the site needs. Only
 * headers are read, and only the start of each file.
 */

const HEAD_BYTES = 8192;

function head(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
/** major.minor of a version like 7.2.24. */
const minor = (v: string) => /^(\d+\.\d+)/.exec(v)?.[1];

/** The lowest major.minor a composer constraint allows: ^7.4 || ^8.0 gives 7.4, >=8.1 gives 8.1. */
export function constraintMinimum(constraint: string): string | undefined {
  const found = [...constraint.matchAll(/(?<![\d.])(\d+)\.(\d+)/g)].map((m) => `${m[1]}.${m[2]}`);
  return found.sort(cmp)[0];
}

const header = (text: string, name: string) => new RegExp(`^[ \\t/*#@]*${name}:\\s*([0-9][0-9.]*)`, 'mi').exec(text)?.[1];

/** The Requires PHP header of a plugin's main file or a theme's style.css. */
export const requiresPhpOf = (file: string) => header(head(file), 'Requires PHP');

export function readPhpRequirements(docroot: string): { version: string; sources: string[] } | undefined {
  const found: Array<{ version: string; source: string }> = [];
  const composer = join(docroot, 'composer.json');
  if (existsSync(composer)) {
    try {
      const php = (JSON.parse(readFileSync(composer, 'utf8')) as { require?: Record<string, string> }).require?.php;
      const v = php ? constraintMinimum(php) : undefined;
      if (v) found.push({ version: v, source: 'composer.json' });
    } catch {
      // A composer.json that does not parse asks for nothing the panel can read.
    }
  }
  const core = head(join(docroot, 'wp-includes', 'version.php'));
  const coreMin = /\$required_php_version\s*=\s*'([\d.]+)'/.exec(core)?.[1];
  const coreVersion = /\$wp_version\s*=\s*'([^']+)'/.exec(core)?.[1];
  if (coreMin && minor(coreMin)) found.push({ version: minor(coreMin) as string, source: `WordPress ${coreVersion ?? ''}`.trim() });

  const content = join(docroot, 'wp-content');
  const dirs = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  };
  // The themes folder, and each repo in wp-content/repos that holds a theme in a folder of its own.
  const themeRoots = [join(content, 'themes'), ...themeFolders(docroot).map((f) => join(content, f))];
  for (const [root, theme] of themeRoots.flatMap((root) => dirs(root).map((theme) => [root, theme] as const))) {
    const v = header(head(join(root, theme, 'style.css')), 'Requires PHP');
    if (v && minor(v)) found.push({ version: minor(v) as string, source: `theme ${theme}` });
  }
  for (const plugin of dirs(join(content, 'plugins'))) {
    let files: string[];
    try {
      files = readdirSync(join(content, 'plugins', plugin)).filter((f) => f.endsWith('.php'));
    } catch {
      continue;
    }
    for (const file of files) {
      const text = head(join(content, 'plugins', plugin, file));
      if (!/Plugin Name:/i.test(text)) continue;
      const v = header(text, 'Requires PHP');
      if (v && minor(v)) found.push({ version: minor(v) as string, source: `plugin ${plugin}` });
      break;
    }
  }
  if (found.length === 0) return undefined;
  const version = found.map((f) => f.version).sort(cmp).at(-1) as string;
  return { version, sources: found.filter((f) => f.version === version).map((f) => f.source) };
}

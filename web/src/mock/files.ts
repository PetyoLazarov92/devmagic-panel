import { type ActionId, type ActionRunResult, type FileEntry, type FileListing, type FileShortcut, type FileTrashEntry, type FileView, FILE_CHANGED, FILE_IMAGE_TYPES, FILE_TEXT_MAX, joinPath, nameOf, parentOf } from '@devmagic-panel/shared';

/** The mockup's site folder: the same tree for every site, made of files a WordPress site has. */

interface MockFile {
  size?: number;
  mode?: string;
  text?: string;
  /** Minutes ago it changed. */
  ago?: number;
  link?: string;
  readOnly?: true;
  binary?: true;
  /** A folder with nothing in it, made in the mockup. */
  dir?: true;
}

const FUNCTIONS = `<?php
/**
 * Wandworks theme: setup, assets and the blocks it adds.
 */

namespace Wandworks;

const VERSION = '3.4.0';

add_action( 'after_setup_theme', function () {
\tadd_theme_support( 'title-tag' );
\tadd_theme_support( 'post-thumbnails' );
\tadd_theme_support( 'editor-styles' );
\tregister_nav_menus( [ 'primary' => __( 'Primary menu', 'wandworks' ) ] );
} );

add_action( 'wp_enqueue_scripts', function () {
\twp_enqueue_style( 'wandworks', get_theme_file_uri( 'dist/app.css' ), [], VERSION );
\twp_enqueue_script( 'wandworks', get_theme_file_uri( 'dist/app.js' ), [], VERSION, true );
} );

/**
 * The spells of one school, newest first.
 */
function spells_of( string $school, int $count = 12 ): array {
\t$query = new \\WP_Query( [
\t\t'post_type'      => 'spell',
\t\t'posts_per_page' => $count,
\t\t'tax_query'      => [ [ 'taxonomy' => 'school', 'field' => 'slug', 'terms' => $school ] ],
\t] );

\treturn $query->posts;
}

require __DIR__ . '/inc/blocks.php';
require __DIR__ . '/inc/shortcodes.php';
`;

const CONFIG = `<?php
define( 'DB_NAME', 'spellbook' );
define( 'DB_USER', 'spellbook' );
define( 'DB_PASSWORD', 'local-only-password' );
define( 'DB_HOST', 'localhost' );

$table_prefix = 'wp_';

define( 'WP_DEBUG', true );
define( 'WP_DEBUG_LOG', true );
define( 'WP_DEBUG_DISPLAY', false );
define( 'WP_ENVIRONMENT_TYPE', 'local' );

if ( ! defined( 'ABSPATH' ) ) {
\tdefine( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`;

const LOG = `[10-Nov-2026 09:12:44 UTC] PHP Warning:  Undefined array key "school" in /var/www/local.spellbook.example/wp-content/themes/wandworks/functions.php on line 28
[10-Nov-2026 09:12:45 UTC] PHP Deprecated:  Creation of dynamic property Wandworks\\Slider::$items is deprecated in /var/www/local.spellbook.example/wp-content/plugins/wandworks-slider/slider.php on line 12
`;

const HTACCESS = `# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
`;

const TREE: Record<string, MockFile> = {
  '.htaccess': { text: HTACCESS, ago: 60 * 24 * 40 },
  'index.php': { text: "<?php\ndefine( 'WP_USE_THEMES', true );\nrequire __DIR__ . '/wp-blog-header.php';\n", ago: 60 * 24 * 90 },
  'wp-config.php': { text: CONFIG, mode: '640', ago: 60 * 24 * 3 },
  'wp-admin': { link: '/var/www/wp-cores/7.1.3/wp-admin' },
  'wp-includes': { link: '/var/www/wp-cores/7.1.3/wp-includes' },
  'wp-admin/index.php': { text: "<?php\n/** Dashboard. */\nrequire_once __DIR__ . '/admin.php';\n", readOnly: true, ago: 60 * 24 * 20 },
  'wp-admin/admin.php': { text: "<?php\n/** WordPress administration bootstrap. */\n", readOnly: true, ago: 60 * 24 * 20 },
  'wp-includes/version.php': { text: "<?php\n$wp_version = '7.1.3';\n", readOnly: true, ago: 60 * 24 * 20 },
  'wp-content/debug.log': { text: LOG, ago: 4 },
  'wp-content/index.php': { text: '<?php\n// Silence is golden.\n', ago: 60 * 24 * 90 },
  'wp-content/mu-plugins/devmagic-panel-login.php': { size: 2140, text: '<?php\n/**\n * Plugin Name: devmagic-panel login\n * Logs you in from the panel with a one-time token. Does nothing off a local address.\n */\n', ago: 60 * 24 * 12 },
  'wp-content/mu-plugins/devmagic-panel-local.php': { size: 9120, text: '<?php\n/**\n * Plugin Name: devmagic-panel Local mode\n * Mail to Mailpit, no indexing, a Local label. Does nothing off a local address.\n */\n', ago: 60 * 24 * 12 },
  'wp-content/plugins/wandworks-slider/slider.php': { text: "<?php\n/**\n * Plugin Name: Wandworks Slider\n * Version: 1.8.2\n */\n\nnamespace Wandworks;\n\nclass Slider {\n\tpublic function __construct() {\n\t\t$this->items = [];\n\t}\n}\n", ago: 60 * 24 * 6 },
  'wp-content/plugins/wandworks-slider/readme.txt': { text: '=== Wandworks Slider ===\nStable tag: 1.8.2\n\nA slider for spells.\n', ago: 60 * 24 * 6 },
  'wp-content/plugins/query-monitor/query-monitor.php': { text: '<?php\n/**\n * Plugin Name: Query Monitor\n */\n', ago: 60 * 24 * 30 },
  'wp-content/plugins/akismet/akismet.php': { text: '<?php\n/**\n * Plugin Name: Akismet Anti-spam\n */\n', ago: 60 * 24 * 30 },
  'wp-content/themes/wandworks/.git/HEAD': { text: 'ref: refs/heads/develop\n', ago: 50 },
  'wp-content/themes/wandworks/node_modules/.package-lock.json': { text: '{}\n', ago: 60 * 24 * 2 },
  'wp-content/themes/wandworks/functions.php': { text: FUNCTIONS, ago: 35 },
  'wp-content/themes/wandworks/style.css': { text: '/*\nTheme Name: Wandworks\nVersion: 3.4.0\nAuthor: Alex Morgan\n*/\n', ago: 60 * 24 * 2 },
  'wp-content/themes/wandworks/theme.json': { text: '{\n  "version": 3,\n  "settings": {\n    "layout": { "contentSize": "720px", "wideSize": "1180px" }\n  }\n}\n', ago: 60 * 24 * 2 },
  'wp-content/themes/wandworks/package.json': { text: '{\n  "name": "wandworks",\n  "scripts": { "prod": "webpack --mode production" }\n}\n', ago: 60 * 24 * 9 },
  'wp-content/themes/wandworks/screenshot.png': { size: 184_320, ago: 60 * 24 * 200 },
  'wp-content/themes/wandworks/inc/blocks.php': { text: "<?php\nnamespace Wandworks;\n\nadd_action( 'init', function () {\n\tregister_block_type( __DIR__ . '/../blocks/spell-card' );\n} );\n", ago: 60 * 24 * 2 },
  'wp-content/themes/wandworks/inc/shortcodes.php': { text: "<?php\nnamespace Wandworks;\n\nadd_shortcode( 'spell', __NAMESPACE__ . '\\\\render_spell' );\n", ago: 60 * 24 * 14 },
  'wp-content/themes/wandworks/dist/app.css': { size: 48_211, text: 'body{margin:0}\n', ago: 60 * 24 * 2 },
  'wp-content/themes/wandworks/dist/app.js': { size: 91_877, text: '(()=>{"use strict"})();\n', ago: 60 * 24 * 2 },
  'wp-content/themes/twentytwentyfive/style.css': { text: '/*\nTheme Name: Twenty Twenty-Five\n*/\n', ago: 60 * 24 * 60 },
  'wp-content/uploads/2026/11/owl-post.jpg': { size: 412_998, ago: 60 * 20 },
  'wp-content/uploads/2026/11/owl-post-300x200.jpg': { size: 18_440, ago: 60 * 20 },
  'wp-content/uploads/2026/11/potion-shelf.webp': { size: 96_300, ago: 60 * 26 },
  'wp-content/uploads/2026/10/spell-list.pdf': { size: 1_204_776, binary: true, ago: 60 * 24 * 21 },
  'wp-content/uploads/2026/10/wand.svg': { text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 21 21 3"/></svg>\n', ago: 60 * 24 * 25 },
  'wp-content/uploads/backup-2026-10.sql.gz': { size: 38_400_112, binary: true, ago: 60 * 24 * 28 },
};

const NOW = Date.now();
const CORE_NOTE = 'This folder is part of a shared WordPress core, outside the site. It is read only here.';
const PANEL = new Set(['wp-content/mu-plugins/devmagic-panel-login.php', 'wp-content/mu-plugins/devmagic-panel-local.php']);
const when = (file: MockFile) => new Date(NOW - (file.ago ?? 60 * 24 * 7) * 60_000).toISOString();
const sizeOf = (file: MockFile) => file.size ?? file.text?.length ?? 0;
// The tree changes as you make, move and delete things in the mockup, so its paths are read each time.
const allPaths = () => Object.keys(TREE);
const isDir = (path: string) => path === '' || TREE[path]?.link !== undefined || TREE[path]?.dir === true || allPaths().some((p) => p.startsWith(`${path}/`));
/** Not a real hash: enough for the mockup to notice a file that changed. */
const hashOf = (text: string) => {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `mock-${text.length}-${(h >>> 0).toString(16)}`;
};
const inCore = (path: string) => /^wp-(admin|includes)(\/|$)/.test(path);
const rootOf = (domain: string) => `/var/www/${domain}`;

const SHORTCUTS: FileShortcut[] = [
  { label: 'wp-content', path: 'wp-content', kind: 'dir' },
  { label: 'Themes', path: 'wp-content/themes', kind: 'dir' },
  { label: 'Plugins', path: 'wp-content/plugins', kind: 'dir' },
  { label: 'Uploads', path: 'wp-content/uploads', kind: 'dir' },
  { label: 'Repo: wandworks', path: 'wp-content/themes/wandworks', kind: 'dir' },
  { label: 'wp-config.php', path: 'wp-config.php', kind: 'file' },
  { label: 'debug.log', path: 'wp-content/debug.log', kind: 'file' },
];

export function mockFiles(domain: string, dir: string): FileListing {
  if (!isDir(dir)) throw new Error(`${dir} is not there any more`);
  const paths = allPaths();
  const names = new Set<string>();
  for (const p of paths) if (parentOf(p) === dir || (dir === '' ? true : p.startsWith(`${dir}/`))) names.add((dir ? p.slice(dir.length + 1) : p).split('/')[0] as string);
  const entries: FileEntry[] = [...names].map((name) => {
    const path = joinPath(dir, name);
    const file = TREE[path];
    if (file?.link) return { name, kind: 'link', writable: false, target: file.link, targetKind: 'dir', outside: true, mode: '777', modifiedAt: when(file) };
    if (!file || file.dir) {
      const newest = Math.min(...paths.filter((p) => p.startsWith(`${path}/`)).map((p) => TREE[p]?.ago ?? 60 * 24 * 7), file?.ago ?? Infinity);
      return { name, kind: 'dir', writable: !inCore(path), mode: '755', modifiedAt: when({ ago: newest }), ...(paths.includes(`${path}/.git/HEAD`) ? { note: 'repo' as const } : {}) };
    }
    return { name, kind: 'file', writable: !file.readOnly, mode: file.mode ?? '644', modifiedAt: when(file), sizeBytes: sizeOf(file), ...(PANEL.has(path) ? { note: 'panel' as const } : {}) };
  });
  entries.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name));
  return { dir, root: rootOf(domain), entries, more: 0, writable: !inCore(dir), ...(inCore(dir) ? { readOnly: CORE_NOTE } : {}), shortcuts: SHORTCUTS };
}

export function mockFileView(_domain: string, path: string): FileView {
  const file = TREE[path];
  if (!file || file.link || file.dir) throw new Error(`${path} is not a file`);
  const facts = { path, sizeBytes: sizeOf(file), modifiedAt: when(file), mode: file.mode ?? '644', writable: !file.readOnly, ...(file.readOnly ? { readOnly: CORE_NOTE } : {}), ...(PANEL.has(path) ? { note: 'panel' as const } : {}) };
  const ext = nameOf(path).split('.').pop()?.toLowerCase() ?? '';
  if (FILE_IMAGE_TYPES[ext]) return { ...facts, kind: 'image' };
  if (facts.sizeBytes > FILE_TEXT_MAX) return { ...facts, kind: 'large' };
  if (file.binary || file.text === undefined) return { ...facts, kind: 'binary' };
  return { ...facts, kind: 'text', text: file.text, hash: hashOf(file.text), eol: 'lf' };
}

/** The mockup has no files to send: a drawn picture for an image, nothing for a download. */
export function mockFileUrl(path: string, show: boolean): string {
  if (!show) return '#';
  const label = nameOf(path).replace(/[<>&"]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><rect width="600" height="400" fill="#7c6ee6"/><circle cx="470" cy="110" r="46" fill="#f5d76e"/><path d="M0 400 180 190l120 130 90-80 210 160z" fill="#3d3580"/><text x="24" y="44" font-family="sans-serif" font-size="20" fill="#fff">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const trash: Array<FileTrashEntry & { files: Record<string, MockFile> }> = [
  { id: '20261109-164210-3fa9c1', deletedAt: new Date(NOW - 17 * 3_600_000).toISOString(), items: ['wp-content/themes/wandworks/inc/old-widgets.php'], sizeBytes: 3_412, files: { 'wp-content/themes/wandworks/inc/old-widgets.php': { text: '<?php\n// The widgets the theme had before blocks.\n', ago: 60 * 24 * 300 } } },
];

export const mockFileTrash = (): FileTrashEntry[] => trash.map(({ files: _files, ...entry }) => entry);

/** Everything at a path: the file, or the folder with what is in it. */
const under = (path: string) => allPaths().filter((p) => p === path || p.startsWith(`${path}/`));
const exists = (path: string) => TREE[path] !== undefined || isDir(path);
const refuse = (message: string): never => {
  throw new Error(message);
};
const ok = (output: string, data?: ActionRunResult['data']): ActionRunResult => ({ runId: 42, ok: true, exitCode: 0, output, ...(data ? { data } : {}) });

function relocate(from: string, to: string, keep: boolean) {
  for (const p of under(from)) {
    const file = TREE[p];
    if (!file) continue;
    TREE[`${to}${p.slice(from.length)}`] = { ...file, ago: keep ? 0 : (file.ago ?? 0) };
    if (!keep) delete TREE[p];
  }
  // A folder left empty by a move is still a folder.
  const parent = parentOf(from);
  if (!keep && parent && !isDir(parent)) TREE[parent] = { dir: true, ago: 0 };
}

function copyName(dir: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n += 1) {
    const candidate = `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`;
    if (!exists(joinPath(dir, candidate))) return candidate;
  }
}

/** The Files tab's actions on the mockup's tree; undefined for any other action. */
/** Files the mockup "uploaded": only their sizes, until file.upload names them. */
const stagedFiles = new Map<string, number>();
export function mockStageFile(file: File): { id: string; sizeBytes: number } {
  const id = crypto.randomUUID();
  stagedFiles.set(id, file.size);
  return { id, sizeBytes: file.size };
}

export function mockFileAction(id: ActionId, input: Record<string, unknown>): ActionRunResult | undefined {
  if (!id.startsWith('file.')) return undefined;
  const files = (input.files as string[] | undefined) ?? [];
  const guard = (path: string) => inCore(path) && refuse(`${path} is part of a shared WordPress core: it is read only here`);
  switch (id) {
    case 'file.write': {
      const path = String(input.file);
      const file = TREE[path];
      if (!file || file.text === undefined) return refuse(`${path} is not there any more`);
      guard(path);
      if (input.hash && input.hash !== hashOf(file.text) && !input.force) return refuse(`${FILE_CHANGED}: ${path}`);
      const text = String(input.content);
      Object.assign(file, { text, ago: 0 });
      delete file.size;
      return ok(`saved ${path}`, { hash: hashOf(text) });
    }
    case 'file.create': {
      const path = joinPath(String(input.dir), String(input.name));
      guard(path);
      if (exists(path)) return refuse(`${String(input.name)} is already there`);
      TREE[path] = input.kind === 'dir' ? { dir: true, ago: 0 } : { text: '', ago: 0 };
      return ok(`made ${path}`);
    }
    case 'file.rename': {
      const from = String(input.file);
      const to = joinPath(parentOf(from), String(input.name));
      guard(from);
      if (exists(to)) return refuse(`${String(input.name)} is already there`);
      relocate(from, to, false);
      return ok(`renamed ${from} to ${String(input.name)}`);
    }
    case 'file.move':
    case 'file.copy': {
      const to = String(input.to);
      guard(to || 'x');
      for (const from of files) {
        guard(from);
        const copy = id === 'file.copy';
        const name = copy && exists(joinPath(to, nameOf(from))) ? copyName(to, nameOf(from)) : nameOf(from);
        if (exists(joinPath(to, name))) return refuse(`${name} is already there`);
        relocate(from, joinPath(to, name), copy);
      }
      return ok(`${id === 'file.copy' ? 'copied' : 'moved'} ${files.length} to ${to || 'the site folder'}`);
    }
    case 'file.delete': {
      const kept: Record<string, MockFile> = {};
      let sizeBytes = 0;
      for (const from of files) {
        guard(from);
        for (const p of under(from)) {
          const file = TREE[p];
          if (!file) continue;
          kept[p] = file;
          sizeBytes += sizeOf(file);
          delete TREE[p];
        }
        const parent = parentOf(from);
        if (parent && !isDir(parent)) TREE[parent] = { dir: true, ago: 0 };
      }
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const entry = { id: `${stamp}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`, deletedAt: new Date().toISOString(), items: files, sizeBytes, files: kept };
      trash.unshift(entry);
      return ok(`deleted ${files.length}`, { trashId: entry.id });
    }
    case 'file.restore': {
      const at = trash.findIndex((t) => t.id === input.id);
      const entry = trash[at];
      if (!entry) return refuse('That delete is not kept any more');
      const there = entry.items.find((item) => exists(item));
      if (there) return refuse(`${there} is there again: rename or delete it first`);
      Object.assign(TREE, entry.files);
      trash.splice(at, 1);
      return ok(`put back ${entry.items.join(', ')}`);
    }
    case 'file.upload': {
      const dir = String(input.dir);
      guard(joinPath(dir, 'x'));
      const placed: string[] = [];
      const taken: string[] = [];
      for (const { id: staged, name } of input.uploads as { id: string; name: string }[]) {
        const path = joinPath(dir, name);
        const size = stagedFiles.get(staged) ?? 0;
        stagedFiles.delete(staged);
        if (exists(path)) taken.push(name);
        else {
          TREE[path] = { size, ago: 0 };
          placed.push(path);
        }
      }
      if (placed.length === 0) return refuse(taken.length === 1 ? `${taken[0]} is already in this folder: nothing is written over` : `All ${taken.length} are already in this folder: nothing is written over`);
      return ok([`uploaded ${placed.join(', ')}`, ...(taken.length ? [`already there, left as it is: ${taken.join(', ')}`] : [])].join('\n'));
    }
    case 'file.compress': {
      const dir = parentOf(files[0] ?? '');
      guard(joinPath(dir, 'x'));
      const stem = files.length === 1 ? nameOf(files[0] ?? '') : nameOf(dir) || 'files';
      let name = `${stem}.zip`;
      for (let n = 2; exists(joinPath(dir, name)); n += 1) name = `${stem} ${n}.zip`;
      TREE[joinPath(dir, name)] = { size: Math.max(1024, Math.round(files.reduce((sum, f) => sum + under(f).reduce((s, p) => s + sizeOf(TREE[p] ?? { dir: true, ago: 0 }), 0), 0) * 0.4)), ago: 0 };
      return ok(`made ${joinPath(dir, name)}`);
    }
    case 'file.extract': {
      const from = String(input.file);
      const dir = parentOf(from);
      guard(from);
      const stem = nameOf(from).replace(/\.(zip|tar|tar\.gz|tgz|tar\.bz2|tar\.xz)$/i, '');
      let name = stem;
      for (let n = 2; exists(joinPath(dir, name)); n += 1) name = `${stem} ${n}`;
      TREE[joinPath(dir, name)] = { dir: true, ago: 0 };
      TREE[joinPath(dir, `${name}/readme.txt`)] = { text: `Unpacked from ${nameOf(from)} (mockup).\n`, ago: 0 };
      return ok(`unpacked into ${joinPath(dir, name)}`);
    }
    default:
      return undefined;
  }
}

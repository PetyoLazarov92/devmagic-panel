import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { actions, isUploadsFolder, uploadsFolderOf, uploadsKind } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { listFileTrash, restoreEntries } from '../src/sites/file-changes.js';
import { chosen, compareUploads, copyChosenUploads, leftOut, parseListing, uploadsHere } from '../src/sites/uploads-compare.js';
import { type FakeCall, fakeExec, wpSiteTree } from './helpers.js';

const src = { host: 'deploy@www.spellbook.example:2222', folder: '/srv/www/spellbook' };
const pad = (n: number) => String(n).padStart(2, '0');
/** A line of rsync --list-only, with the time as this machine prints it. */
const line = (file: string, bytes: number, at = new Date(2026, 10, 9, 10, 0, 0), kind = '-rw-r--r--') =>
  `${kind} ${String(bytes).padStart(14)} ${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${file}`;

const LISTING = [
  line('.', 4096, undefined, 'drwxr-xr-x'),
  line('2026/11', 4096, undefined, 'drwxr-xr-x'),
  line('2026/11/wand.jpg', 500_000),
  line('2026/11/wand-300x200.jpg', 20_000),
  line('2026/11/here.jpg', 100),
  line('2026/11/edited.jpg', 900, new Date(2026, 10, 9, 12, 0, 0)),
  line('2026/10/spell book.pdf', 3_000_000),
  line('2026/11/link.jpg', 9, undefined, 'lrwxrwxrwx'),
  line('elementor/css/post-7.css', 4000),
  line('woocommerce_uploads/invoice.pdf', 70_000),
  line('sites/3/2026/11/learn.png', 8000),
  line('site-logo.png', 1200),
  line('odd [name]/x.jpg', 5),
  line('2026/11/shell.php', 66),
  line('cache/page.html', 77),
  line('../escape.jpg', 1),
].join('\n');

function tree() {
  const t = wpSiteTree();
  const uploads = join(t.docroot, 'wp-content/uploads');
  mkdirSync(join(uploads, '2026/11'), { recursive: true });
  writeFileSync(join(uploads, '2026/11/here.jpg'), 'x'.repeat(100));
  writeFileSync(join(uploads, '2026/11/edited.jpg'), 'mine');
  utimesSync(join(uploads, '2026/11/edited.jpg'), new Date(2026, 10, 1), new Date(2026, 10, 1));
  writeFileSync(join(uploads, '2026/11/local-only.jpg'), 'only here');
  return { ...t, uploads, trash: join(t.root, 'file-trash') };
}

/** A server whose rsync lists LISTING, and brings what it is asked for as the real one would report it. */
function server(onCopy?: (call: FakeCall) => void, listing = LISTING) {
  return fakeExec({
    ssh: (call) => (call.args.join(' ').includes(' plugin path') ? { stdout: '/srv/www/spellbook/wp-content/plugins\n' } : { code: 1, stderr: 'not faked' }),
    rsync: (call) => {
      if (call.args.includes('--list-only')) return { stdout: listing };
      onCopy?.(call);
      const n = (call.input ?? '').split('\0').filter(Boolean).length;
      return { stdout: `     1,000  50%    1.00kB/s    0:00:00 (xfr#1, to-chk=1/${n})\n     2,000 100%    1.00kB/s    0:00:00 (xfr#${n}, to-chk=0/${n})\n\nNumber of regular files transferred: ${n}\nTotal transferred file size: 3,500,000 bytes\n` };
    },
  });
}

describe('uploads from production, compared', () => {
  it('names folders by what they are for', () => {
    expect(uploadsFolderOf('2026/11/wand.jpg')).toEqual({ key: '2026/11', kind: 'media' });
    expect(uploadsFolderOf('sites/3/2026/11/learn.png')).toEqual({ key: 'sites/3/2026/11', kind: 'media', site: 3 });
    expect(uploadsFolderOf('site-logo.png')).toEqual({ key: '.', kind: 'other' });
    expect(uploadsFolderOf('sites/3/logo.png')).toEqual({ key: 'sites/3/.', kind: 'other', site: 3 });
    expect([uploadsKind('elementor'), uploadsKind('woocommerce_uploads'), uploadsKind('gravity_forms'), uploadsKind('wandworks-press')]).toEqual(['generated', 'private', 'private', 'other']);
    expect(['2026/11', 'sites/3/2026/11', '.', 'elementor'].every(isUploadsFolder)).toBe(true);
    expect(['../etc', '2026/11/x', 'a/b', '*', 'odd [name]', '..', '/2026/11', '--delete', 'sites/x/2026/11'].some(isUploadsFolder)).toBe(false);
  });

  it('reads only the files of a listing, without links, code, cache folders and names that leave the folder', () => {
    const files = parseListing(LISTING).map((f) => f.file);
    expect(files).toEqual(['2026/11/wand.jpg', '2026/11/wand-300x200.jpg', '2026/11/here.jpg', '2026/11/edited.jpg', '2026/10/spell book.pdf', 'elementor/css/post-7.css', 'woocommerce_uploads/invoice.pdf', 'sites/3/2026/11/learn.png', 'site-logo.png', 'odd [name]/x.jpg']);
    expect(parseListing(LISTING)[0]).toMatchObject({ bytes: 500_000, mtime: new Date(2026, 10, 9, 10, 0, 0).getTime() });
    expect([leftOut('a/b.php'), leftOut('backup-2026/x.zip'), leftOut('2026/11/.htaccess'), leftOut('2026/11/a.jpg')]).toEqual([true, true, true, false]);
  });

  it('compares folder by folder: what is new, what changed, what is only here, and only reads on both sides', async () => {
    const t = tree();
    const fake = server();
    const c = await compareUploads(fake.exec, t.docroot, src);
    expect(c).toMatchObject({ host: src.host, dir: '/srv/www/spellbook/wp-content/uploads', files: 10, changedFiles: 1, onlyHere: ['2026/11/local-only.jpg'], onlyHereFiles: 1, unusual: 1 });
    expect(c.changed).toEqual([{ file: '2026/11/edited.jpg', bytes: 900, changedAt: new Date(2026, 10, 9, 12, 0, 0).toISOString() }]);
    const by = Object.fromEntries(c.folders.map((f) => [f.key, f]));
    expect(by['2026/11']).toMatchObject({ kind: 'media', files: 4, newFiles: 2, newBytes: 520_000, newResizedFiles: 1, newResizedBytes: 20_000, changedFiles: 1 });
    expect(by['elementor']).toMatchObject({ kind: 'generated', newFiles: 1 });
    expect(by['woocommerce_uploads']).toMatchObject({ kind: 'private' });
    expect(by['sites/3/2026/11']).toMatchObject({ kind: 'media', site: 3 });
    expect(by['.']).toMatchObject({ kind: 'other', newBytes: 1200 });
    // Months newest first.
    expect(c.folders.filter((f) => f.kind === 'media' && !f.site).map((f) => f.key)).toEqual(['2026/11', '2026/10']);
    // One read with WP-CLI and one listing: nothing is copied, deleted or tried out.
    expect(fake.calls.map((x) => x.file)).toEqual(['ssh', 'rsync']);
    const rsync = fake.calls[1]?.args ?? [];
    expect(rsync).toEqual(expect.arrayContaining(['--list-only', '--no-links', '--exclude=*.php', '--exclude=/cache/']));
    expect(rsync.some((a) => /^--(delete|remove-source|backup|dry-run)/.test(a))).toBe(false);
    expect(rsync.at(-1)).toBe('deploy@www.spellbook.example:/srv/www/spellbook/wp-content/uploads/');
    expect(readFileSync(join(t.uploads, '2026/11/edited.jpg'), 'utf8')).toBe('mine');
    expect(uploadsHere(t.docroot)).toMatchObject({ exists: true, files: 3, bytes: 113 });
  });

  it('brings the new files of the folders you chose, named one by one, only adding', async () => {
    const t = tree();
    const fake = server();
    const notes: string[] = [];
    const out = await copyChosenUploads(fake.exec, t.docroot, src, { folders: ['2026/11', '.'] }, { trash: t.trash, site: 'local.shop.com', root: t.docroot, progress: (_f, note) => notes.push(note) });
    expect(out.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(out[0]?.stdout).toContain('3 files of the folders you chose are not here yet');
    expect(out[1]?.stdout).toContain('copied 3 files (3 MB) into wp-content/uploads');
    const copy = fake.calls.filter((x) => x.file === 'rsync')[1] as FakeCall;
    expect(copy.input).toBe('2026/11/wand.jpg\x002026/11/wand-300x200.jpg\x00site-logo.png\x00');
    expect(copy.args).toEqual(expect.arrayContaining(['--ignore-existing', '--no-links', '--partial', '--from0', '--files-from=-', '--exclude=*.php']));
    expect(copy.args.some((a) => /^--(delete|remove-source|inplace|backup|update|recursive)/.test(a))).toBe(false);
    expect(copy.args.slice(-3)).toEqual(['--', 'deploy@www.spellbook.example:/srv/www/spellbook/wp-content/uploads/', `${t.uploads}/`]);
    expect(notes.at(-1)).toBe('New files: 3 of 3');
    // Nothing went to the trash: nothing was replaced.
    expect(existsSync(t.trash)).toBe(false);
  });

  it('leaves resized copies and large files on the server when asked, and says so when there is nothing to bring', async () => {
    const t = tree();
    const read = { dir: '/x', server: parseListing(LISTING), local: new Map([['2026/11/here.jpg', { bytes: 100, mtime: 0 }]]), content: t.docroot, localDir: t.uploads };
    expect(chosen(read, { folders: ['2026/11', '2026/10'], originalsOnly: true, maxFileMb: 1 }).fresh.map((f) => f.file)).toEqual(['2026/11/wand.jpg', '2026/11/edited.jpg']);
    // Changed files are not chosen unless asked for.
    expect(chosen(read, { folders: ['2026/11'] }).changed).toEqual([]);
    const fake = server(undefined, [line('2026/11/here.jpg', 100)].join('\n'));
    const out = await copyChosenUploads(fake.exec, t.docroot, src, { folders: ['2026/11'] }, { trash: t.trash, site: 'local.shop.com', root: t.docroot });
    expect(out.at(-1)?.stdout).toBe('nothing to bring: what you chose is here already');
    expect(fake.calls.filter((x) => x.file === 'rsync')).toHaveLength(1);
  });

  it('refuses what would not fit, and a stopped run keeps what came', async () => {
    const t = tree();
    const big = server(undefined, line('2026/11/film.mp4', 900_000_000_000_000));
    const out = await copyChosenUploads(big.exec, t.docroot, src, { folders: ['2026/11'] }, { trash: t.trash, site: 'local.shop.com', root: t.docroot });
    expect(out.at(-1)).toMatchObject({ code: 1, stderr: expect.stringContaining('not copied. Choose fewer folders, or make room') });
    expect(big.calls.filter((x) => x.file === 'rsync')).toHaveLength(1);
    const stop = new AbortController();
    const fake = server(() => stop.abort());
    const stopped = await copyChosenUploads(fake.exec, t.docroot, src, { folders: ['2026/11'] }, { trash: t.trash, site: 'local.shop.com', root: t.docroot, signal: stop.signal });
    expect(stopped.at(-1)).toMatchObject({ code: 1, stderr: 'stopped: what came so far is kept, and a new run brings the rest' });
  });

  it('brings files that changed on production only when asked, and keeps the ones they replace for Undo', async () => {
    const t = tree();
    const edited = join(t.uploads, '2026/11/edited.jpg');
    // rsync as it works with --backup-dir: the file here moves there, and the newer one takes its place.
    const fake = server((call) => {
      const backup = call.args.find((a) => a.startsWith('--backup-dir='))?.slice('--backup-dir='.length);
      if (!backup) return;
      mkdirSync(join(backup, '2026/11'), { recursive: true });
      writeFileSync(join(backup, '2026/11/edited.jpg'), readFileSync(edited));
      writeFileSync(edited, 'from production');
    });
    const out = await copyChosenUploads(fake.exec, t.docroot, src, { folders: ['2026/11'], changed: true }, { trash: t.trash, site: 'local.shop.com', root: t.docroot });
    expect(out.every((r) => r.code === 0)).toBe(true);
    expect(out.map((r) => r.stdout).join('\n')).toContain('brought 1 file that changed on production');
    const [fresh, changed] = fake.calls.filter((x) => x.file === 'rsync').slice(1) as [FakeCall, FakeCall];
    expect(fresh.args).toContain('--ignore-existing');
    expect(changed.input).toBe('2026/11/edited.jpg\0');
    expect(changed.args).toEqual(expect.arrayContaining(['--update', '--backup']));
    expect(changed.args).not.toContain('--ignore-existing');
    expect(changed.args.some((a) => /^--(delete|remove-source)/.test(a))).toBe(false);
    // The backup folder is the file trash's own, never a path from the server.
    expect(dirname(changed.args.find((a) => a.startsWith('--backup-dir='))?.slice(13) ?? '').startsWith(t.trash)).toBe(true);

    const [entry] = listFileTrash(t.trash, 'local.shop.com');
    expect(entry).toMatchObject({ reason: 'replaced', items: ['wp-content/uploads/2026/11/edited.jpg'], sizeBytes: 4 });
    // Put back trades the two: mine returns, and the one from production is kept in its turn.
    expect(await restoreEntries({ root: t.docroot, readRoots: [] }, t.trash, 'local.shop.com', entry?.id ?? '')).toEqual(['wp-content/uploads/2026/11/edited.jpg']);
    expect(readFileSync(edited, 'utf8')).toBe('mine');
    expect(listFileTrash(t.trash, 'local.shop.com')).toHaveLength(1);
    await restoreEntries({ root: t.docroot, readRoots: [] }, t.trash, 'local.shop.com', entry?.id ?? '');
    expect(readFileSync(edited, 'utf8')).toBe('from production');
  });

  it('takes folders only as the view names them', () => {
    const input = { domain: 'local.shop.com', host: 'shop-prod', folder: '/srv/www/shop' };
    const schema = actions['site.copyUploads'].input;
    expect(schema.safeParse({ ...input, folders: ['2026/11', 'sites/3/2026/11', '.', 'elementor'], maxFileMb: 50, originalsOnly: true, changed: true }).success).toBe(true);
    for (const bad of ['../../etc', '2026/11/../..', '*', '--delete', 'a b', '/etc']) expect(schema.safeParse({ ...input, folders: [bad] }).success).toBe(false);
    expect(schema.safeParse({ ...input, folders: [] }).success).toBe(false);
  });
});

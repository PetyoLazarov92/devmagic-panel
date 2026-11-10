import type { UploadsCompare, UploadsFolder, UploadsHere } from '@devmagic-panel/shared';

/** Uploads from production in the mockup: a server with more than is here, and a copy that brings what you ticked. */
const folder = (key: string, kind: UploadsFolder['kind'], files: number, bytes: number, newFiles: number, newBytes: number, more: Partial<UploadsFolder> = {}): UploadsFolder => ({
  key, kind, files, bytes, newFiles, newBytes,
  newResizedFiles: kind === 'media' ? Math.round(newFiles * 0.7) : 0,
  newResizedBytes: kind === 'media' ? Math.round(newBytes * 0.35) : 0,
  changedFiles: 0, changedBytes: 0, ...more,
});

const FOLDERS: UploadsFolder[] = [
  folder('2026/11', 'media', 412, 96_400_000, 388, 91_200_000, { changedFiles: 2, changedBytes: 610_000 }),
  folder('2026/10', 'media', 655, 148_000_000, 640, 143_500_000),
  folder('2026/09', 'media', 590, 131_700_000, 590, 131_700_000),
  folder('2026/08', 'media', 222, 48_300_000, 222, 48_300_000),
  folder('2026/07', 'media', 318, 74_900_000, 0, 0),
  folder('2026/06', 'media', 401, 88_000_000, 0, 0),
  folder('2025/12', 'media', 1_240, 302_000_000, 1_240, 302_000_000),
  folder('sites/2/2026/11', 'media', 96, 21_800_000, 96, 21_800_000, { site: 2 }),
  folder('sites/2/2026/10', 'media', 140, 30_100_000, 140, 30_100_000, { site: 2 }),
  folder('elementor', 'generated', 318, 12_400_000, 318, 12_400_000),
  folder('smush-webp', 'generated', 2_904, 188_000_000, 2_904, 188_000_000),
  folder('woocommerce_uploads', 'private', 86, 240_000_000, 86, 240_000_000),
  folder('gravity_forms', 'private', 1_530, 96_000_000, 1_530, 96_000_000),
  folder('wandworks-press', 'other', 24, 3_100_000, 24, 3_100_000),
  folder('.', 'other', 3, 48_000, 1, 12_000),
];

const copied = new Set<string>();
let brought = false;
let last: UploadsHere['last'];
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export function mockUploadsHere(): UploadsHere {
  const got = FOLDERS.filter((f) => copied.has(f.key));
  return {
    exists: true,
    files: 742 + got.reduce((n, f) => n + f.newFiles, 0),
    bytes: 163_400_000 + got.reduce((n, f) => n + f.newBytes, 0),
    freeBytes: 2_600_000_000 - got.reduce((n, f) => n + f.newBytes, 0),
    ...(last ? { last } : {}),
  };
}

export function mockUploadsCompare(host: string, dir: string): UploadsCompare {
  const folders = FOLDERS.map((f) => (copied.has(f.key) ? { ...f, newFiles: 0, newBytes: 0, newResizedFiles: 0, newResizedBytes: 0, ...(brought ? { changedFiles: 0, changedBytes: 0 } : {}) } : f));
  const changed = brought && copied.has('2026/11') ? [] : [
    { file: '2026/11/owl-post.jpg', bytes: 428_112, changedAt: ago(60 * 5) },
    { file: '2026/11/potion-shelf.webp', bytes: 181_888, changedAt: ago(60 * 30) },
  ];
  return {
    host,
    dir: `${dir}/wp-content/uploads`,
    files: folders.reduce((n, f) => n + f.files, 0),
    bytes: folders.reduce((n, f) => n + f.bytes, 0),
    folders,
    changed,
    changedFiles: changed.length,
    onlyHere: ['2026/10/spell-list.pdf', '2026/10/wand.svg', '2026/11/draft-banner.png'],
    onlyHereFiles: 3,
    unusual: 1,
    freeBytes: mockUploadsHere().freeBytes,
  };
}

export function mockUploadsCopied(folders: readonly string[], host: string, changed: boolean) {
  for (const key of folders) copied.add(key);
  if (changed) brought = true;
  last = { at: new Date().toISOString(), host };
}

import type { FolderListing } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { childRows, foldersShowingAll, type ListedPath, topRows } from '../src/lib/path-tree.js';

const at = (kind: string, path: string, exists = true): ListedPath => ({ kind, path, exists, note: '' });
const listed = [
  at('packages', 'apt:rclone'),
  at('dir', '/usr/local/lib/devmagic-panel'),
  at('file', '/usr/local/lib/devmagic-panel/bin/dmp-root'),
  at('file', '/usr/local/lib/devmagic-panel/lib/apache.sh'),
  at('dir', '/var/lib/devmagic-panel'),
  at('dir', '/home/acme/.local/share/devmagic-panel/gone', false),
  at('link', '/etc/apache2/sites-enabled/local.devmagic-ssl.conf'),
];

describe('the file lists as a tree', () => {
  it('shows at the top what no listed folder holds, in the list order, and only a folder that is there opens', () => {
    expect(topRows(listed).map((r) => [r.path, r.folder])).toEqual([
      ['apt:rclone', false],
      ['/usr/local/lib/devmagic-panel', true],
      ['/var/lib/devmagic-panel', true],
      ['/home/acme/.local/share/devmagic-panel/gone', false],
      ['/etc/apache2/sites-enabled/local.devmagic-ssl.conf', false],
    ]);
  });

  it('shows an open folder as it is on disk, with what the list says, folders first', () => {
    const listing: FolderListing = {
      path: '/usr/local/lib/devmagic-panel/bin',
      entries: [{ name: 'dmp-root', kind: 'file', sizeBytes: 42 }, { name: 'wpcore', kind: 'file' }],
      more: 0,
    };
    const rows = childRows('/usr/local/lib/devmagic-panel/bin', listed, listing);
    expect(rows.map((r) => [r.name, Boolean(r.listed), r.entry?.sizeBytes])).toEqual([['dmp-root', true, 42], ['wpcore', false, undefined]]);
    const current: FolderListing = { path: '/data', entries: [{ name: 'current', kind: 'link', target: 'releases/v1', targetKind: 'dir' }, { name: 'panel.db', kind: 'file' }], more: 0 };
    expect(childRows('/data', [], current).map((r) => [r.name, r.folder])).toEqual([['current', true], ['panel.db', false]]);
  });

  it('keeps the listed paths a folder it cannot read holds, and the folders on the way to them', () => {
    const unread: FolderListing = { path: '/usr/local/lib/devmagic-panel', entries: [], more: 0, error: 'only root can list this' };
    expect(childRows('/usr/local/lib/devmagic-panel', listed, unread).map((r) => [r.name, r.folder])).toEqual([['bin', true], ['lib', true]]);
    expect(childRows('/usr/local/lib/devmagic-panel/bin', listed, undefined).map((r) => r.name)).toEqual(['dmp-root']);
  });

  it('opens on Expand all the folders that show every listed path, and no others', () => {
    expect(foldersShowingAll(listed).sort()).toEqual(['/usr/local/lib/devmagic-panel', '/usr/local/lib/devmagic-panel/bin', '/usr/local/lib/devmagic-panel/lib', '/var/lib/devmagic-panel']);
  });
});

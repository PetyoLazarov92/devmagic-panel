import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { RunStore } from '../src/store.js';

describe('RunStore', () => {
  it('adds the skipped column to a run history from before it, keeping the runs', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dmp-store-')), 'panel.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, input TEXT NOT NULL, exit_code INTEGER,
      output TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, finished_at TEXT)`);
    old.prepare("INSERT INTO runs (action, input, exit_code, started_at, finished_at) VALUES ('site.create', '{}', 0, '2026-10-25T08:00:00Z', '2026-10-25T08:03:00Z')").run();
    old.close();

    const store = new RunStore(file);
    expect(store.get(1)).toMatchObject({ action: 'site.create', exitCode: 0, skipped: null });
    const id = store.start('site.create', {});
    store.finish(id, 0, 'done, 2 steps skipped', 2);
    expect(store.get(id)?.skipped).toBe(2);
    // A second open, like the MCP server's, finds the column there.
    expect(new RunStore(file).get(id)?.skipped).toBe(2);
  });

  it('keeps no count for a run without skipped steps', () => {
    const store = new RunStore(':memory:');
    const id = store.start('hosts.add', {});
    store.finish(id, 0, 'ok', 0);
    expect(store.get(id)?.skipped).toBeNull();
  });

  it('marks one skipped step of a site under a path done, and says when there is none', () => {
    const store = new RunStore(':memory:');
    store.setInstall('local.shop.com', '/learn', { how: 'wordpress', at: '2026-10-25T08:00:00Z', skipped: [{ label: 'Flush caches', todo: 'flush them' }] });
    expect(store.skippedDone('local.shop.com', undefined, 'Flush caches')).toBe(false);
    expect(store.skippedDone('local.shop.com', '/learn', 'Run the build')).toBe(false);
    expect(store.skippedDone('local.shop.com', '/learn', 'Flush caches')).toBe(true);
    expect(store.installs().get('local.shop.com/learn')).toEqual({ how: 'wordpress', at: '2026-10-25T08:00:00Z' });
  });
});

describe('runs a restart cut off', () => {
  it('ends them as stopped at start, and leaves the panel\'s own updates to their installer', () => {
    const store = new RunStore(':memory:');
    const cleanup = store.start('db.cleanOrphans', { domain: 'local.shop.com' });
    const update = store.start('panel.installRelease', {});
    const done = store.start('cert.reissue', {});
    store.finish(done, 0, 'ok');
    expect(store.stopUnfinished('Stopped: the panel restarted while it ran.', (a) => a.startsWith('panel.'))).toBe(1);
    const runs = store.recent();
    expect(runs.find((r) => r.id === cleanup)).toMatchObject({ exitCode: 1, output: 'Stopped: the panel restarted while it ran.' });
    expect(runs.find((r) => r.id === update)?.finishedAt ?? null).toBeNull();
    expect(runs.find((r) => r.id === done)).toMatchObject({ exitCode: 0, output: 'ok' });
  });
});

describe('what a removed site leaves behind', () => {
  it('moves what a restore needs into the archive, drops caches, and brings them back on a restore', () => {
    const store = new RunStore(':memory:');
    store.setInstall('local.spellbook.example', undefined, { how: 'repo', repo: 'git@github.com:wandworks/site.git' });
    store.setMeta('cron-removed:local.spellbook.example', '[{"id":"a"}]');
    store.setMeta('htaccess-dismissed:local.spellbook.example', '{"/":"abc"}');
    store.setMeta('wpdb-report:local.spellbook.example#1', '{}');
    store.setMeta('wpdb-report:local.spellbook.example/learn#1', '{}');
    store.setMeta('wpdb-report:local.spellbook.example.test#1', '{}');
    store.archiveInstall('local.spellbook.example', 'local.spellbook.example-20261109-101500');
    expect(store.getMeta('cron-removed:local.spellbook.example')).toBeUndefined();
    expect(store.getMeta('htaccess-dismissed:local.spellbook.example')).toBeUndefined();
    expect(store.metaKeys('wpdb-report:local.spellbook.example')).toEqual(['wpdb-report:local.spellbook.example.test#1']);
    expect(store.archiveIds()).toEqual(['local.spellbook.example-20261109-101500']);

    store.restoreArchiveMeta('local.spellbook.example-20261109-101500');
    expect(store.getMeta('cron-removed:local.spellbook.example')).toBe('[{"id":"a"}]');
    expect(store.getMeta('htaccess-dismissed:local.spellbook.example')).toBe('{"/":"abc"}');
  });

  it('forgets the records of archives the purge removed', async () => {
    const { sweepArchives } = await import('../src/sites/trash.js');
    const store = new RunStore(':memory:');
    for (const id of ['local.a.test-20261020-080000', 'local.b.test-20261108-080000']) {
      store.setInstall(id.slice(0, -16), undefined, { how: 'hand' });
      store.setMeta(`cron-removed:${id.slice(0, -16)}`, '[]');
      store.archiveInstall(id.slice(0, -16), id);
    }
    expect(sweepArchives(store, [{ id: 'local.b.test-20261108-080000' }])).toEqual(['local.a.test-20261020-080000']);
    expect(store.archiveIds()).toEqual(['local.b.test-20261108-080000']);
    expect(store.archivedInstall('local.a.test-20261020-080000')).toBeUndefined();
  });

  it('lists remembered repo answers, the last used first, and forgets one', () => {
    const store = new RunStore(':memory:');
    store.savePreset('https://github.com/wandworks/site', { layout: 'site-root' });
    store.savePreset('https://gitlab.com/wandworks/web/store', { layout: 'wp-content' });
    expect(store.presets().map((p) => p.repo)).toHaveLength(2);
    expect(store.deletePreset('https://github.com/wandworks/site')).toBe(true);
    expect(store.deletePreset('https://github.com/wandworks/site')).toBe(false);
    expect(store.presets().map((p) => p.repo)).toEqual(['https://gitlab.com/wandworks/web/store']);
  });
});

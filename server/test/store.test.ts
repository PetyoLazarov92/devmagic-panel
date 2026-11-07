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

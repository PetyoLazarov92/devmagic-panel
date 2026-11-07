import type { WpDbReport } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import type { ExecResult, Executor } from '../src/exec.js';
import { read } from '../src/mysql-browse.js';
import { RunStore } from '../src/store.js';
import { cachedReport, forgetReport, keepReport, SharedReads } from '../src/wordpress-report-cache.js';
import { tempTree } from './helpers.js';

const mysql = { user: 'devmagic_panel', host: 'localhost', password: 'adminpw' };

const report = (over: Partial<WpDbReport>): WpDbReport => ({ database: 'shop_com', prefix: 'wp_', blog: 1, blogPrefix: 'wp_', missingTables: [], errors: {}, checkedAt: '2026-11-07T09:00:00.000Z', ...over });

describe('the kept WordPress report', () => {
  it('keeps each part with when it was read, and a failed read keeps the last good value', () => {
    const store = new RunStore(':memory:');
    keepReport(store, 'local.shop.com', undefined, 1, report({ content: { revisions: 5, autoDrafts: 0, trashedPosts: 0, spamComments: 0, trashedComments: 0 } }), ['content']);
    keepReport(store, 'local.shop.com', undefined, 1, report({ autoload: { count: 3, bytes: 10, limitBytes: 800_000, top: [] }, checkedAt: '2026-11-07T10:00:00.000Z' }), ['autoload']);
    const failed = report({ content: null, errors: { content: 'MySQL stopped the read after 60 seconds' }, checkedAt: '2026-11-07T11:00:00.000Z' });
    keepReport(store, 'local.shop.com', undefined, 1, failed, ['content']);
    const kept = cachedReport(store, 'local.shop.com', undefined, 1);
    expect(kept?.content?.revisions).toBe(5);
    expect(kept?.autoload?.count).toBe(3);
    expect(kept?.errors).toEqual({});
    expect(kept?.readAt).toEqual({ content: '2026-11-07T09:00:00.000Z', autoload: '2026-11-07T10:00:00.000Z' });
    expect(kept).not.toHaveProperty('metaKeys');
  });

  it('is kept per site of a network and forgotten for the whole site', () => {
    const store = new RunStore(':memory:');
    keepReport(store, 'local.shop.com', undefined, 1, report({ users: { count: 1, list: [] } }), ['users']);
    keepReport(store, 'local.shop.com', undefined, 2, report({ blog: 2, users: { count: 4, list: [] } }), ['users']);
    keepReport(store, 'local.shop.com', '/learn', 1, report({ users: { count: 9, list: [] } }), ['users']);
    expect(cachedReport(store, 'local.shop.com', undefined, 2)?.users?.count).toBe(4);
    forgetReport(store, 'local.shop.com');
    expect(cachedReport(store, 'local.shop.com', undefined, 1)).toBeUndefined();
    expect(cachedReport(store, 'local.shop.com', undefined, 2)).toBeUndefined();
    expect(cachedReport(store, 'local.shop.com', '/learn', 1)?.users?.count).toBe(9);
  });
});

describe('shared reads', () => {
  it('runs one read for requests that ask the same, and stops it only once every one has gone', async () => {
    const reads = new SharedReads<string>();
    let started = 0;
    let signal: AbortSignal | undefined;
    let finish: (v: string) => void = () => {};
    const start = (s: AbortSignal) => {
      started += 1;
      signal = s;
      return new Promise<string>((done) => {
        finish = done;
      });
    };
    const first = new AbortController();
    const second = new AbortController();
    const a = reads.read('k', start, first.signal);
    const b = reads.read('k', start, second.signal);
    expect(started).toBe(1);
    first.abort();
    expect(signal?.aborted).toBe(false);
    second.abort();
    expect(signal?.aborted).toBe(true);
    finish('done');
    await expect(Promise.all([a, b])).resolves.toEqual(['done', 'done']);
    reads.read('k', start, new AbortController().signal);
    expect(started).toBe(2);
  });
});

describe('a read nobody waits for', () => {
  it('stops in MySQL too, with KILL QUERY on its own connection', async () => {
    const calls: string[] = [];
    const exec: Executor = (file, args, options) => {
      const line = [file, ...args].join(' ');
      calls.push(line);
      if (args.includes('-e')) return Promise.resolve<ExecResult>({ code: 0, stdout: args.at(-1) === 'SELECT VERSION()' ? '8.0.43\n' : '', stderr: '' });
      return new Promise((resolve) => {
        options?.onStdout?.('dmp-connection\t4242\n');
        options?.signal?.addEventListener('abort', () => resolve({ code: 1, stdout: '', stderr: 'stopped: no longer needed' }));
      });
    };
    const gone = new AbortController();
    const reading = read({ config: tempTree().config, exec, mysql, kept: () => [], signal: gone.signal }, 'SELECT 1;\n');
    await new Promise((r) => setTimeout(r, 5));
    gone.abort();
    await expect(reading).rejects.toMatchObject({ status: 499 });
    expect(calls.some((c) => c.endsWith('KILL QUERY 4242'))).toBe(true);
    expect(calls.find((c) => c.includes('--unbuffered'))).toBeDefined();
  });
});

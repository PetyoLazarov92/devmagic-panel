import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { DRAFT_IDLE_MS, DraftRefused, Drafts } from '../src/drafts.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, tempTree } from './helpers.js';

const A = '11111111-2222-4333-8444-555555555555';
const UP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UP2 = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';

function upload(dir: string, id: string): string {
  const folder = join(dir, id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'dump.sql'), 'CREATE TABLE x;');
  return folder;
}

function clocked() {
  const t = tempTree();
  const uploads = join(t.root, 'uploads');
  let now = Date.parse('2026-10-25T10:00:00Z');
  const drafts = new Drafts(new RunStore(':memory:'), uploads, () => now);
  return { t, uploads, drafts, advance: (ms: number) => (now += ms) };
}

const answers = { kind: 'manual' as const, title: 'local.shop.com', step: 'domains', state: { repoUrl: 'git@github.com:acme/shop.git' }, uploads: [UP] };

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id) as JobView;
    if (view.status !== 'running' && view.status !== 'undoing') return view;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

describe('install drafts', () => {
  it('keep the answers for 24 hours after the last change, then go with their uploads', () => {
    const s = clocked();
    const folder = upload(s.uploads, UP);
    expect(s.drafts.save(A, answers)).toMatchObject({ id: A, status: 'open', expiresAt: '2026-10-26T10:00:00.000Z' });
    s.advance(20 * 3_600_000);
    // A change starts the 24 hours again.
    s.drafts.save(A, { ...answers, step: 'wordpress' });
    s.advance(20 * 3_600_000);
    expect(s.drafts.sweep(() => false)).toBe(0);
    expect(s.drafts.uploadsInUse()).toEqual(new Set([UP]));
    s.advance(4 * 3_600_000 + 1);
    expect(s.drafts.sweep(() => false)).toBe(1);
    expect(s.drafts.list()).toEqual([]);
    expect(existsSync(folder)).toBe(false);
  });

  it('never keep a password, a key or a token', () => {
    const s = clocked();
    const saved = s.drafts.save(A, { ...answers, uploads: [], state: { adminPassword: 'hunter2', adminUser: 'admin', nested: { apiKey: 'sk-x', token: 'abc', keep: 1 }, empty: { password: null } } });
    expect(saved.state).toEqual({ adminUser: 'admin', nested: { keep: 1 }, empty: { password: null } });
    // A Claude Code run's token counts are only numbers, and stay; a token object with text in it does not.
    const counts = s.drafts.save(A, { ...answers, uploads: [], state: { read: { tokens: { input: 2, output: 1104 } }, auth: { token: { value: 'abc' } } } });
    expect(counts.state).toEqual({ read: { tokens: { input: 2, output: 1104 } }, auth: {} });
  });

  it('let go of an upload the wizard replaced, and discard everything when asked', () => {
    const s = clocked();
    const first = upload(s.uploads, UP);
    const second = upload(s.uploads, UP2);
    s.drafts.save(A, answers);
    s.drafts.save(A, { ...answers, uploads: [UP2] });
    expect(existsSync(first)).toBe(false);
    s.drafts.discard(A);
    expect(existsSync(second)).toBe(false);
    expect(s.drafts.get(A)).toBeUndefined();
  });

  it('stay while their install runs, open again after a failure, and refuse changes meanwhile', () => {
    const s = clocked();
    upload(s.uploads, UP);
    s.drafts.save(A, answers);
    s.drafts.installing(A, 'job-1');
    expect(s.drafts.get(A)).toMatchObject({ status: 'installing', jobId: 'job-1' });
    expect(s.drafts.get(A)?.expiresAt).toBeUndefined();
    expect(() => s.drafts.save(A, answers)).toThrow(DraftRefused);
    expect(() => s.drafts.discard(A)).toThrow(DraftRefused);
    s.advance(10 * DRAFT_IDLE_MS);
    expect(s.drafts.sweep((id) => id === 'job-1')).toBe(0);

    s.drafts.reopen(A);
    expect(s.drafts.get(A)).toMatchObject({ status: 'failed' });
    expect(Date.parse(s.drafts.get(A)?.expiresAt ?? '')).toBeGreaterThan(Date.parse('2026-10-26T00:00:00Z'));
  });
});

describe('site.create from a draft', () => {
  it('marks the draft installing, and drops it with its files once the site is in place', async () => {
    const t = tempTree();
    const uploads = join(t.root, 'uploads');
    const store = new RunStore(':memory:');
    const drafts = new Drafts(store, uploads);
    const folder = upload(uploads, UP);
    drafts.save(A, answers);
    const fake = fakeExec({ [`sudo -n ${DMP}`]: { stdout: 'ok' } });
    const jobs = new Jobs(store);
    const ctx: ActionContext = {
      config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: '/x/wpcore', wpcoreConf: join(t.root, 'wpcore.conf'), home: t.hostPaths.home,
      jobs, uploadsDir: uploads, secrets: null, drafts,
    };
    const result = await runAction(ctx, 'site.create', { source: 'empty', domain: 'local.new.com', draftId: A });
    expect(drafts.get(A)).toMatchObject({ status: 'installing', jobId: result.data?.jobId });
    expect((await settle(jobs, result.data?.jobId ?? '')).status).toBe('done');
    expect(drafts.get(A)).toBeUndefined();
    expect(existsSync(folder)).toBe(false);
    expect(store.installs().get('local.new.com')).toMatchObject({ how: 'empty' });
  });
});

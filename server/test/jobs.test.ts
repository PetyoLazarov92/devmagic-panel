import { describe, expect, it } from 'vitest';
import { Jobs, KEPT_ACTIVITY, locksMeet, type JobStep, type JobView } from '../src/jobs.js';
import { RunStore } from '../src/store.js';

const ok = (stdout = 'ok') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 200; i++) {
    const view = jobs.get(id) as JobView;
    if (view.status !== 'running' && view.status !== 'undoing') return view;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

describe('Jobs', () => {
  it('runs steps in order, stops at a failure, and retries from that step', async () => {
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    const ran: string[] = [];
    let attempts = 0;
    const steps: JobStep[] = [
      { id: 'a', label: 'A', run: async () => (ran.push('a'), ok()) },
      { id: 'b', label: 'B', run: async () => (ran.push('b'), ++attempts === 1 ? fail('no db') : ok()) },
      { id: 'c', label: 'C', run: async () => (ran.push('c'), ok()) },
    ];
    const runId = store.start('site.create', {});
    const started = jobs.start(steps, { runId, title: 'Create', target: 'local.a.com' });
    let view = await settle(jobs, started.id);
    expect(view.status).toBe('failed');
    expect(view.steps.map((s) => s.status)).toEqual(['done', 'failed', 'pending']);
    expect(view.steps[1]?.output).toBe('no db');
    expect(store.recent()[0]).toMatchObject({ exitCode: 1 });

    jobs.retry(started.id);
    view = await settle(jobs, started.id);
    expect(view.status).toBe('done');
    expect(ran).toEqual(['a', 'b', 'b', 'c']);
    expect(store.recent()[0]).toMatchObject({ exitCode: 0 });
  });

  it('undoes what the steps made, newest first, and keeps going past a failed undo', async () => {
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    const undone: string[] = [];
    const steps: JobStep[] = [
      { id: 'a', label: 'A', run: async (job) => (job.onUndo('Remove A', async () => (undone.push('a'), ok())), ok()) },
      { id: 'b', label: 'B', run: async (job) => (job.onUndo('Remove B', async () => (undone.push('b'), fail('busy'))), ok()) },
      { id: 'c', label: 'C', run: async (job) => (job.onUndo('Remove C', async () => (undone.push('c'), ok())), fail()) },
    ];
    const started = jobs.start(steps, { runId: store.start('site.create', {}), title: 'Create' });
    await settle(jobs, started.id);
    jobs.undo(started.id);
    const view = await settle(jobs, started.id);
    expect(undone).toEqual(['c', 'b', 'a']);
    expect(view.undo.map((u) => [u.label, u.status])).toEqual([['Remove C', 'done'], ['Remove B', 'failed'], ['Remove A', 'done']]);
    expect(view.status).toBe('failed');
  });

  it('skips a failed step the job marks skippable, goes on, and finishes with it skipped', async () => {
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    const ran: string[] = [];
    let ended: JobView | undefined;
    const steps: JobStep[] = [
      { id: 'a', label: 'A', run: async () => (ran.push('a'), ok()) },
      { id: 'build', label: 'Run the build', run: async () => (ran.push('build'), fail('spawn npm ENOENT')), skippable: 'run it in a terminal' },
      { id: 'c', label: 'C', run: async () => (ran.push('c'), ok()) },
    ];
    const runId = store.start('site.create', {});
    const started = jobs.start(steps, { runId, title: 'Create', target: 'local.a.com', onDone: (view) => { ended = view; } });
    let view = await settle(jobs, started.id);
    expect(view.status).toBe('failed');
    expect(view.steps[1]).toMatchObject({ status: 'failed', skippable: 'run it in a terminal' });

    expect(jobs.skip(started.id)?.status).toBe('running');
    view = await settle(jobs, started.id);
    expect(view.status).toBe('done');
    expect(view.steps.map((s) => s.status)).toEqual(['done', 'skipped', 'done']);
    expect(view.steps[1]?.output).toBe('spawn npm ENOENT');
    expect(view.progress).toBe(1);
    expect(ran).toEqual(['a', 'build', 'c']);
    expect(ended?.steps[1]?.status).toBe('skipped');
    expect(store.get(runId)?.output).toContain('done, 1 step skipped');
    // Run history keeps the count, for its warning icon.
    expect(store.get(runId)?.skipped).toBe(1);
  });

  it('refuses to skip a step that is not skippable, or a job that did not fail', async () => {
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    const runId = store.start('site.create', {});
    const started = jobs.start([{ id: 'db', label: 'Create the database', run: async () => fail('no db') }], { runId, title: 'Create' });
    expect((await settle(jobs, started.id)).status).toBe('failed');
    expect(jobs.skip(started.id)).toBeUndefined();
    const done = jobs.start([{ id: 'a', label: 'A', run: async () => ok(), skippable: 'x' }], { runId: store.start('site.create', {}), title: 'Other' });
    await settle(jobs, done.id);
    expect(jobs.skip(done.id)).toBeUndefined();
  });

  it('refuses retry on a finished job and undo while running', async () => {
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const started = jobs.start([{ id: 'a', label: 'A', run: async () => (await gate, ok()) }], { runId: store.start('x', {}), title: 'X' });
    expect(jobs.undo(started.id)).toBeUndefined();
    release();
    await settle(jobs, started.id);
    expect(jobs.retry(started.id)).toBeUndefined();
  });
});

describe('Jobs activity', () => {
  it('keeps the last lines of what a step did while it runs and after, first in its output, the end last', async () => {
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    let release = () => undefined as void;
    const held = new Promise<void>((r) => (release = r));
    const steps: JobStep[] = [
      {
        id: 'read',
        label: 'Read',
        run: async (job) => {
          for (let i = 1; i <= 25; i++) job.activity?.(`line ${i}`);
          await held;
          return fail('stopped at the cap');
        },
      },
    ];
    const started = jobs.start(steps, { runId: store.start('org.readRepo', {}), title: 'Read' });
    await new Promise((r) => setTimeout(r, 5));
    expect(jobs.get(started.id)?.steps[0]?.activity).toHaveLength(KEPT_ACTIVITY);
    expect(jobs.get(started.id)?.steps[0]?.activity?.[0]).toBe('line 6');
    release();
    const view = await settle(jobs, started.id);
    expect(view.steps[0]?.activity?.at(-1)).toBe('line 25');
    expect(view.steps[0]?.output?.split('\n')).toEqual([...Array.from({ length: 20 }, (_, i) => `line ${i + 6}`), 'stopped at the cap']);
  });
});

describe('Jobs locks', () => {
  it('meets a site and the sites under its paths, not a longer domain', () => {
    expect(locksMeet('local.shop.com', 'local.shop.com')).toBe(true);
    expect(locksMeet('local.shop.com', 'local.shop.com/learn')).toBe(true);
    expect(locksMeet('local.shop.com/learn', 'local.shop.com')).toBe(true);
    expect(locksMeet('local.shop.com/learn', 'local.shop.com/blog')).toBe(false);
    expect(locksMeet('local.shop.com', 'local.shop.com.au')).toBe(false);
  });

  it('is busy while a job runs or an action holds the key, and free once the job fails', async () => {
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const started = jobs.start([{ id: 'a', label: 'A', run: async () => (await gate, fail()) }], { runId: store.start('site.remove', {}), title: 'Remove local.a.com', target: 'local.a.com', kind: 'site.remove' });
    expect(jobs.busyFor('local.a.com/learn')).toMatchObject({ title: 'Remove local.a.com', jobId: started.id, kind: 'site.remove' });
    expect(jobs.busyFor('local.b.com')).toBeUndefined();
    release();
    await settle(jobs, started.id);
    expect(jobs.busyFor('local.a.com')).toBeUndefined();

    const done = jobs.hold('local.b.com', 'Delete a deleted site');
    expect(jobs.busyFor('local.b.com')).toEqual({ title: 'Delete a deleted site' });
    done();
    expect(jobs.busyFor('local.b.com')).toBeUndefined();
  });

  it('lists what Undo takes back, newest first, and has no undo when a job made nothing', async () => {
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    const made = jobs.start(
      [
        { id: 'a', label: 'A', run: async (job) => (job.onUndo('Remove A', async () => ok()), ok()) },
        { id: 'b', label: 'B', run: async (job) => (job.onUndo('Remove B', async () => ok()), fail()) },
      ],
      { runId: store.start('x', {}), title: 'X' },
    );
    expect((await settle(jobs, made.id)).undoable).toEqual(['Remove B', 'Remove A']);
    jobs.undo(made.id);
    expect((await settle(jobs, made.id)).undoable).toEqual([]);

    const nothing = jobs.start([{ id: 'a', label: 'A', run: async () => fail() }], { runId: store.start('x', {}), title: 'Y' });
    await settle(jobs, nothing.id);
    expect(jobs.undo(nothing.id)).toBeUndefined();
  });
});

describe('Jobs queue and progress', () => {
  // A step that waits until the test lets it go.
  function gate() {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((r) => (open = r));
    return { open, step: (id: string): JobStep => ({ id, label: id, run: async () => (await opened, ok()) }) };
  }

  it('runs at most the limit of one kind at once, starts the queued one when a slot frees, and lists active jobs first', async () => {
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    const g = gate();
    const start = (target: string) => jobs.start([g.step('x')], { runId: store.start('site.create', {}), title: target, target, kind: 'site.create', limit: 2 });
    const a = start('local.a.com');
    const b = start('local.b.com');
    const c = start('local.c.com');
    expect([a.status, b.status, c.status]).toEqual(['running', 'running', 'queued']);
    expect(jobs.activeFor('site.create', 'local.c.com')?.id).toBe(c.id);
    expect(jobs.activeFor('site.create', 'local.z.com')).toBeUndefined();
    g.open();
    expect((await settle(jobs, a.id)).status).toBe('done');
    for (let i = 0; i < 200 && jobs.get(c.id)?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 2));
    expect(jobs.get(c.id)?.status).toBe('done');
    expect(jobs.list().every((j) => j.status === 'done')).toBe(true);
  });

  it('reports step progress with a note and an overall share weighted by step', async () => {
    const store = new RunStore(':memory:');
    const jobs = new Jobs(store);
    let seen: JobView | undefined;
    const steps: JobStep[] = [
      { id: 'quick', label: 'Quick', run: async () => ok() },
      {
        id: 'import',
        label: 'Import',
        weight: 3,
        run: async (job) => {
          job.progress(0.5, '1 GB of 2 GB');
          seen = jobs.get(view.id);
          return ok();
        },
      },
    ];
    const view = jobs.start(steps, { runId: store.start('db.import', {}), title: 'Import' });
    const done = await settle(jobs, view.id);
    expect(seen?.steps[1]).toMatchObject({ status: 'running', progress: 0.5, note: '1 GB of 2 GB' });
    // One finished step of weight 1, plus half of a step of weight 3, out of 4.
    expect(seen?.progress).toBeCloseTo(2.5 / 4);
    expect(done.progress).toBe(1);
    expect(done.steps[1]?.progress).toBeUndefined();
  });
});

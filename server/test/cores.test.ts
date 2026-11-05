import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionInputError, runAction, type ActionContext } from '../src/actions.js';
import type { CoreStatusMap } from '../src/core-status.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { addableReleases, coresReport } from '../src/sites/cores.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, wpSiteTree } from './helpers.js';

const WPCORE = '/usr/local/lib/devmagic-panel/bin/wpcore';
const STATUS: CoreStatusMap = {
  '7.1.3': 'latest', '7.1.2': 'insecure', '7.0.7': 'outdated', '7.0.4': 'insecure', '6.9.10': 'outdated', '6.8.3': 'insecure', '6.8.11': 'outdated', '6.8.1': 'insecure', '4.9.26': 'insecure',
};

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id) as JobView;
    if (view.status !== 'running' && view.status !== 'undoing') return view;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

function setup(options: Parameters<typeof wpSiteTree>[0] = {}, status: CoreStatusMap | null = STATUS) {
  const t = wpSiteTree(options);
  const fake = fakeExec({ [`sudo -n ${WPCORE} add`]: { stdout: 'WordPress added' }, [`sudo -n ${WPCORE} remove-core`]: { stdout: 'Core removed.' } });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const ctx: ActionContext = {
    config: t.config, exec: fake.exec, store, dmpRoot: DMP, wpcoreBin: WPCORE, wpcoreConf: t.wpcoreConf, home: t.hostPaths.home,
    jobs, uploadsDir: join(t.root, 'uploads'), secrets: null, coreStatus: async () => status,
  };
  return { ...t, ctx, jobs, calls: fake.calls };
}

describe('addableReleases', () => {
  it('offers the newest release of each recent branch that is safe and not installed', () => {
    expect(addableReleases(STATUS, ['7.1.3'])).toEqual([
      { version: '7.0.7', status: 'outdated' },
      { version: '6.9.10', status: 'outdated' },
      { version: '6.8.11', status: 'outdated' },
    ]);
    expect(addableReleases(STATUS, [], 1)).toEqual([{ version: '7.1.3', status: 'latest' }]);
  });
});

describe('coresReport', () => {
  it('lists cores newest first with their status and the sites on them', () => {
    const s = setup();
    expect(coresReport(s.config, s.wpcoreConf, STATUS)).toEqual({
      coresDir: join(s.root, 'wp-cores'),
      ready: true,
      latest: '7.1.3',
      cores: [
        { version: '7.1.3', status: 'latest', sites: ['local.shop.com'] },
        { version: '6.8.3', status: 'insecure', sites: [] },
      ],
      standalone: [],
      available: [
        { version: '7.0.7', status: 'outdated' },
        { version: '6.9.10', status: 'outdated' },
        { version: '6.8.11', status: 'outdated' },
      ],
      insecure: ['7.1.2', '7.0.4', '6.8.3', '6.8.1', '4.9.26'],
    });
  });

  it('lists a WordPress install under a path with its core, by its name with the path', () => {
    const s = setup();
    const learn = join(s.config.WEB_DIR, 'local.learn.shop.com');
    mkdirSync(learn, { recursive: true });
    symlinkSync(join(s.root, 'wp-cores/6.8.3/wp-includes'), join(learn, 'wp-includes'));
    const vhost = join(s.config.APACHE_SITES_AVAILABLE, 'local.shop.com-ssl.conf');
    writeFileSync(vhost, readFileSync(vhost, 'utf8').replace(' SSLCertificateFile', ` Alias /learn ${learn}\n SSLCertificateFile`));
    expect(coresReport(s.config, s.wpcoreConf, STATUS).cores).toEqual([
      { version: '7.1.3', status: 'latest', sites: ['local.shop.com'] },
      { version: '6.8.3', status: 'insecure', sites: ['local.shop.com/learn'] },
    ]);
  });

  it('lists sites with their own copy apart, and works offline', () => {
    const s = setup({ ownCore: true });
    const report = coresReport(s.config, s.wpcoreConf, null);
    expect(report.standalone).toEqual([{ domain: 'local.shop.com', version: '6.8.1' }]);
    expect(report.available).toEqual([]);
    expect(report.insecure).toEqual([]);
    expect(report.latest).toBeUndefined();
  });
});

describe('core.add', () => {
  it('downloads with wpcore as a job, answering no to any question', async () => {
    const s = setup();
    const result = await runAction(s.ctx, 'core.add', { version: '7.0.7' });
    const view = await settle(s.jobs, result.data?.jobId as string);
    expect(view.status).toBe('done');
    expect(s.calls[0]).toMatchObject({ file: 'sudo', args: ['-n', WPCORE, 'add', '7.0.7'], input: 'n\n' });
  });

  it('refuses installed, unknown and insecure versions before running anything', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'core.add', { version: '7.1.3' })).rejects.toThrow(/already installed/);
    await expect(runAction(s.ctx, 'core.add', { version: '9.9.9' })).rejects.toThrow(/not a release/);
    await expect(runAction(s.ctx, 'core.add', { version: '6.8.1' })).rejects.toThrow(/security issues/);
    await expect(runAction(s.ctx, 'core.add', { version: '7.1; rm -rf /' })).rejects.toBeInstanceOf(ActionInputError);
    expect(s.calls).toHaveLength(0);
  });

  it('adds a release with security issues for testing once the version is typed', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'core.add', { version: '6.8.1', confirmInsecure: '6.8' })).rejects.toThrow(/security issues/);
    const result = await runAction(s.ctx, 'core.add', { version: '6.8.1', confirmInsecure: '6.8.1' });
    expect((await settle(s.jobs, result.data?.jobId as string)).status).toBe('done');
    expect(s.calls[0]).toMatchObject({ args: ['-n', WPCORE, 'add', '6.8.1'] });
  });

  it('lets wpcore try any version while WordPress.org cannot be reached', async () => {
    const s = setup({}, null);
    const result = await runAction(s.ctx, 'core.add', { version: '6.9.10' });
    expect((await settle(s.jobs, result.data?.jobId as string)).status).toBe('done');
  });
});

describe('core.remove', () => {
  it('removes an unused core with the typed version, confirming wpcore\'s question', async () => {
    const s = setup();
    expect((await runAction(s.ctx, 'core.remove', { version: '6.8.3', confirm: '6.8.3' })).ok).toBe(true);
    expect(s.calls[0]).toMatchObject({ args: ['-n', WPCORE, 'remove-core', '6.8.3'], input: 'y\n' });
  });

  it('refuses a core a site uses, a missing one, and a wrong confirmation', async () => {
    const s = setup();
    await expect(runAction(s.ctx, 'core.remove', { version: '7.1.3', confirm: '7.1.3' })).rejects.toThrow(/used by local\.shop\.com/);
    await expect(runAction(s.ctx, 'core.remove', { version: '5.0.1', confirm: '5.0.1' })).rejects.toThrow(/not installed/);
    await expect(runAction(s.ctx, 'core.remove', { version: '6.8.3', confirm: '6.8' })).rejects.toBeInstanceOf(ActionInputError);
    expect(s.calls).toHaveLength(0);
  });
});

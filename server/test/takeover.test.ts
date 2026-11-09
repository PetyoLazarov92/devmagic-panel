import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionContext } from '../src/actions.js';
import { Jobs, type JobView } from '../src/jobs.js';
import { removalRefusal } from '../src/sites/remove.js';
import { parseTakeover } from '../src/sites/takeover.js';
import { RunStore } from '../src/store.js';
import { DMP, fakeExec, tempTree } from './helpers.js';

const CHECK = `FILE=hand.conf
ENABLED=hand.conf
NAME=www.local.hand.com
NAME=local.hand.com
DOCROOT=/var/www/local.hand.com
MOUNT=/learn=local.learn.hand.com
`;

async function settle(jobs: Jobs, id: string): Promise<JobView> {
  for (let i = 0; i < 500; i++) {
    const view = jobs.get(id) as JobView;
    if (view.status !== 'running' && view.status !== 'undoing') return view;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not settle');
}

function setup(check = CHECK) {
  const t = tempTree();
  const fake = fakeExec({
    [`sudo -n ${DMP} vhost-adopt local.hand.com --check`]: { stdout: check },
    [`sudo -n ${DMP} vhost-adopt local.hand.com`]: { stdout: 'ok: took over local.hand.com' },
    [`sudo -n ${DMP} vhost-release local.hand.com`]: { stdout: 'ok: gave local.hand.com its own vhost back' },
    [`sudo -n ${DMP} cert-issue`]: { stdout: 'ok' },
    [`sudo -n ${DMP} hosts-add`]: { stdout: 'ok' },
  });
  const store = new RunStore(':memory:');
  const jobs = new Jobs(store);
  const ctx = { config: t.config, exec: fake.exec, store, dmpRoot: DMP, jobs, uploadsDir: join(t.root, 'uploads'), secrets: null, home: t.root, wpcoreBin: '', wpcoreConf: '' } as unknown as ActionContext;
  return { ...t, ctx, store, jobs, calls: fake.calls };
}
const lines = (calls: Array<{ file: string; args: string[] }>) => calls.map((c) => [c.file, ...c.args].join(' '));

describe('taking over a site made by hand', () => {
  it('reads what dmp-root found, local names only', () => {
    expect(parseTakeover(`${CHECK}EXTRA=php_value memory_limit 512M\nPROBLEM=shop.example.com is not a local name\nNAME=shop.example.com\n`)).toEqual({
      files: ['hand.conf'],
      enabled: ['hand.conf'],
      names: ['local.hand.com', 'www.local.hand.com'],
      docroot: '/var/www/local.hand.com',
      mounts: ['/learn=local.learn.hand.com'],
      extra: ['php_value memory_limit 512M'],
      problems: ['shop.example.com is not a local name'],
    });
  });

  it('issues the certificate, puts the panel vhost in place, adds the hosts line and notes it; Undo gives it back', async () => {
    const s = setup();
    s.store.setInstall('local.hand.com', undefined, { how: 'hand' });
    const started = await runAction(s.ctx, 'site.takeOver', { domain: 'local.hand.com', confirm: 'local.hand.com' });
    const view = await settle(s.jobs, started.data?.jobId ?? '');
    expect(view.status).toBe('done');
    expect(lines(s.calls).filter((l) => l.startsWith('sudo') && !l.includes('--check'))).toEqual([
      `sudo -n ${DMP} cert-issue local.hand.com www.local.hand.com`,
      `sudo -n ${DMP} vhost-adopt local.hand.com`,
      `sudo -n ${DMP} hosts-add local.hand.com www.local.hand.com`,
    ]);
    expect(s.store.installs().get('local.hand.com')).toMatchObject({ how: 'hand', takenOver: { files: ['hand.conf'], docroot: '/var/www/local.hand.com', dropped: 0 } });

    await s.jobs.undo(view.id);
    await settle(s.jobs, view.id);
    expect(lines(s.calls)).toContain(`sudo -n ${DMP} vhost-release local.hand.com`);
    expect(s.store.installs().get('local.hand.com')?.takenOver).toBeUndefined();
  });

  it('refuses before anything runs: a mistyped domain, what dmp-root found wrong, and lines it would drop without the tick', async () => {
    const s = setup(`${CHECK}EXTRA=Header set X 1\n`);
    await expect(runAction(s.ctx, 'site.takeOver', { domain: 'local.hand.com', confirm: 'local.hand' })).rejects.toThrow(/Type the domain/);
    await expect(runAction(s.ctx, 'site.takeOver', { domain: 'local.hand.com', confirm: 'local.hand.com' })).rejects.toThrow(/1 line the panel's does not keep/);
    const bad = setup(`${CHECK}PROBLEM=hand.conf also holds local.other.com: split it into a file of its own first\n`);
    await expect(runAction(bad.ctx, 'site.takeOver', { domain: 'local.hand.com', confirm: 'local.hand.com' })).rejects.toThrow(/also holds local.other.com/);
    expect(lines(s.calls).filter((l) => !l.includes('--check'))).toEqual([]);

    const dropped = await runAction(s.ctx, 'site.takeOver', { domain: 'local.hand.com', confirm: 'local.hand.com', dropLines: true });
    await settle(s.jobs, dropped.data?.jobId ?? '');
    expect(lines(s.calls)).toContain(`sudo -n ${DMP} vhost-adopt local.hand.com --drop-lines`);
  });

  it('gives the site its own vhost back and forgets the takeover', async () => {
    const s = setup();
    s.store.setInstall('local.hand.com', undefined, { how: 'hand', takenOver: { at: '2026-11-09T10:00:00.000Z', files: ['hand.conf'], docroot: '/var/www/local.hand.com', dropped: 0 } });
    const r = await runAction(s.ctx, 'site.giveBack', { domain: 'local.hand.com', confirm: 'local.hand.com' });
    expect(r.ok).toBe(true);
    expect(s.store.installs().get('local.hand.com')).toEqual({ how: 'hand' });
  });

  it('lets a site taken over go to the trash from a folder named otherwise, when dmp-root registered it', () => {
    const t = tempTree();
    const folder = join(t.config.WEB_DIR, 'old-hand-site');
    mkdirSync(folder, { recursive: true });
    const vhost = join(t.config.APACHE_SITES_AVAILABLE, 'local.hand.com-ssl.conf');
    expect(removalRefusal(t.config, 'local.hand.com', folder, vhost)).toMatch(/remove it by hand/);
    mkdirSync(join(t.config.STATE_DIR, 'sites'), { recursive: true });
    const st = statSync(folder);
    writeFileSync(join(t.config.STATE_DIR, 'sites', 'local.hand.com'), `${folder}\n${st.dev}:${st.ino}\n`);
    expect(removalRefusal(t.config, 'local.hand.com', folder, vhost)).toBeNull();
  });
});

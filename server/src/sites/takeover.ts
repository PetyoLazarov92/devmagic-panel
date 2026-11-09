import type { ActionInput, TakeoverPreview } from '@devmagic-panel/shared';
import { isLocalName } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import type { ExecResult, Executor } from '../exec.js';
import { runRoot } from '../exec.js';
import type { JobStep } from '../jobs.js';
import type { RunStore } from '../store.js';

/**
 * Taking over a site made by hand, and giving it back. dmp-root does the
 * root work (vhost-adopt, vhost-release in scripts/lib/takeover.sh); the
 * panel shows what it would do first, issues the certificate and adds the
 * hosts line, and keeps how the site came here in its install record.
 */

export interface TakeoverContext {
  config: SystemConfig;
  exec: Executor;
  dmpRoot: string;
  store: RunStore;
}

export class TakeoverRefused extends Error {}

/** The KEY=VALUE lines of vhost-adopt --check as a preview. */
export function parseTakeover(text: string): TakeoverPreview {
  const all = (key: string) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].map((m) => (m[1] as string).trim()).filter(Boolean);
  const docroot = all('DOCROOT')[0];
  return {
    files: all('FILE'),
    enabled: all('ENABLED'),
    names: all('NAME').filter(isLocalName).sort((a, b) => a.length - b.length || a.localeCompare(b)),
    ...(docroot ? { docroot } : {}),
    mounts: all('MOUNT'),
    extra: all('EXTRA'),
    problems: all('PROBLEM'),
  };
}

/** What taking over would do, asked of dmp-root, which changes nothing with --check. */
export async function takeoverPreview(ctx: Pick<TakeoverContext, 'exec' | 'dmpRoot'>, domain: string): Promise<TakeoverPreview> {
  const r = await runRoot(ctx.exec, ctx.dmpRoot, ['vhost-adopt', domain, '--check']);
  if (r.code !== 0) throw new TakeoverRefused(r.stderr.trim() || 'dmp-root could not read the vhost');
  return parseTakeover(r.stdout);
}

/**
 * The takeover as a job: the certificate from the local CA for every name,
 * the panel's vhost in place of the site's own (dmp-root keeps the originals
 * and puts them back when Apache refuses), and the hosts line in the panel's
 * block. Undo gives the original vhost back.
 */
export async function planTakeOver(ctx: TakeoverContext, input: ActionInput<'site.takeOver'>): Promise<JobStep[]> {
  const preview = await takeoverPreview(ctx, input.domain);
  if (preview.problems.length) throw new TakeoverRefused(preview.problems.join('; '));
  if (preview.extra.length && !input.dropLines) throw new TakeoverRefused(`its vhost has ${preview.extra.length} line${preview.extra.length === 1 ? '' : 's'} the panel's does not keep: tick to leave them out (they stay in the kept files)`);
  const root = (...args: string[]) => runRoot(ctx.exec, ctx.dmpRoot, args, 5 * 60_000);
  const names = [input.domain, ...preview.names.filter((n) => n !== input.domain)];
  return [
    { id: 'cert', label: `Issue a certificate for ${names.length} name${names.length === 1 ? '' : 's'} from the local CA`, run: () => root('cert-issue', ...names) },
    {
      id: 'vhost',
      label: "Put the panel's vhost in place of the site's own",
      run: async (job) => {
        const r = await root('vhost-adopt', input.domain, ...(input.dropLines ? ['--drop-lines'] : []));
        if (r.code === 0) {
          job.onUndo("Give the site its own vhost back", async () => {
            const back = await root('vhost-release', input.domain);
            if (back.code === 0) forgetTakeover(ctx.store, input.domain);
            return back;
          });
        }
        return r;
      },
    },
    { id: 'hosts', label: "Add the hosts line to the panel's block", run: () => root('hosts-add', ...names) },
    {
      id: 'record',
      label: 'Note that the panel took it over',
      run: async () => {
        const before = ctx.store.installs().get(input.domain);
        ctx.store.setInstall(input.domain, undefined, {
          ...(before ?? { how: 'hand' }),
          takenOver: { at: new Date().toISOString(), files: preview.files, docroot: preview.docroot ?? '', dropped: preview.extra.length },
        });
        return ok(`${input.domain} was made by hand; the panel manages its vhost from now on`);
      },
    },
  ];
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

/** The install record without the takeover, once the site has its own vhost again. */
export function forgetTakeover(store: Pick<RunStore, 'installs' | 'setInstall'>, domain: string): void {
  const record = store.installs().get(domain);
  if (!record?.takenOver) return;
  const { takenOver: _gone, ...rest } = record;
  store.setInstall(domain, undefined, rest);
}

/** Gives the site its own vhost back, and the install record forgets the takeover. */
export async function giveBack(ctx: TakeoverContext, input: ActionInput<'site.giveBack'>): Promise<ExecResult[]> {
  const r = await runRoot(ctx.exec, ctx.dmpRoot, ['vhost-release', input.domain], 5 * 60_000);
  if (r.code === 0) forgetTakeover(ctx.store, input.domain);
  return [r];
}

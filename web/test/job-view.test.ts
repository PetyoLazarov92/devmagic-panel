import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { JobView } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { foldDue, runningJobOf } from '../src/lib/job-view.js';

const job = (id: string, kind: string, status: JobView['status'], target?: string, startedAt = '2026-11-19T10:00:00Z'): JobView => ({
  id, title: id, kind, status, steps: [], undo: [], undoable: [], progress: 0, startedAt, runId: 1, ...(target ? { target } : {}),
});

describe('a job coming back where it was started', () => {
  const list = [
    job('old', 'php.install', 'running', 'php', '2026-11-19T09:00:00Z'),
    job('new', 'php.install', 'queued', 'php', '2026-11-19T10:00:00Z'),
    job('done', 'php.upgrade', 'done', 'php', '2026-11-19T11:00:00Z'),
    job('undoing', 'site.setPhp', 'undoing', 'local.spellbook.example/learn'),
    job('other-site', 'site.setPhp', 'running', 'local.wandworks-store.example'),
  ];

  it('is the newest job of its kinds that still runs, never a finished one', () => {
    expect(runningJobOf(list, { kinds: ['php.install', 'php.upgrade'] })?.id).toBe('new');
    expect(runningJobOf(list, { kinds: ['php.upgrade'] })).toBeUndefined();
  });

  it('is only one about the site the place shows, when the place names it', () => {
    expect(runningJobOf(list, { kinds: ['site.setPhp'], targets: ['local.spellbook.example/learn', 'local.spellbook.example'] })?.id).toBe('undoing');
    expect(runningJobOf(list, { kinds: ['site.setPhp'], targets: ['local.shop.com'] })).toBeUndefined();
  });
});

describe('a job box folding', () => {
  const box = { folded: false, kept: false, inside: false, open: null };

  it('folds a job that ended well, and never a failed or running one', () => {
    expect(foldDue({ ...box, status: 'done' })).toBe(true);
    expect(foldDue({ ...box, status: 'undone' })).toBe(true);
    for (const status of ['failed', 'running', 'queued', 'undoing'] as const) expect(foldDue({ ...box, status })).toBe(false);
  });

  it('waits while you read it, and stays open once you opened it again', () => {
    expect(foldDue({ ...box, status: 'done', inside: true })).toBe(false);
    expect(foldDue({ ...box, status: 'done', open: 'apt' })).toBe(false);
    expect(foldDue({ ...box, status: 'done', kept: true })).toBe(false);
    expect(foldDue({ ...box, status: 'done', folded: true })).toBe(false);
  });
});

describe('jobs on every page', () => {
  const src = join(__dirname, '../src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
  });
  const all = files(src).map((path) => ({ path: relative(src, path), text: readFileSync(path, 'utf8') }));

  it('draw their steps through JobBox or JobFooter, but for the views that are the job itself', () => {
    // The job's page, the update screen, the new site wizard's steps, the assistant's drawer, and the box itself.
    const own = new Set(['features/jobs/job-steps.tsx', 'features/jobs/job-box.tsx', 'features/jobs/job-screen.tsx', 'features/updates/update-install.tsx', 'features/new-site/database.tsx', 'features/assistant/assistant-drawer.tsx']);
    expect(all.filter((f) => f.text.includes('<StepList') && !own.has(f.path)).map((f) => f.path)).toEqual([]);
  });

  it('can be dismissed once they settled, wherever a page shows one', () => {
    const boxes = all.flatMap((f) => [...f.text.matchAll(/<Job(?:Box|Footer)\b[\s\S]*?\/>/g)].map((m) => ({ path: f.path, tag: m[0] })));
    expect(boxes.length).toBeGreaterThan(20);
    expect(boxes.filter((b) => b.path !== 'features/jobs/job-box.tsx' && !b.tag.includes('onDismiss')).map((b) => b.path)).toEqual([]);
  });
});

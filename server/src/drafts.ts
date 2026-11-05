import type { InstallDraft } from '@devmagic-panel/shared';
import { z } from 'zod';
import { removeUpload } from './sites/uploads.js';
import type { RunStore } from './store.js';

/** An open draft goes this long after its last change. */
export const DRAFT_IDLE_MS = 24 * 3_600_000;
const MAX_STATE_BYTES = 256 * 1024;

/** What the wizard sends to save a draft; the server sets the rest. */
export const draftInput = z.object({
  kind: z.enum(['manual', 'organization']).default('manual'),
  title: z.string().trim().max(200).default(''),
  step: z.string().regex(/^[a-z-]{1,40}$/),
  state: z.record(z.string(), z.unknown()),
  uploads: z.array(z.string().regex(/^[0-9a-f-]{36}$/)).max(10).default([]),
});
export const draftId = z.string().uuid();

export class DraftRefused extends Error {}

/** Only numbers, like a Claude Code run's token counts: nothing in it can be a secret. */
const onlyNumbers = (v: unknown) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((n) => typeof n === 'number');

/** The answers without anything secret: a draft never keeps a password, a key or a token, whatever the browser sends. */
export function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, v]) => !(/password|secret|token|apikey/i.test(key) && v !== null && !onlyNumbers(v)))
        .map(([key, v]) => [key, withoutSecrets(v)]),
    );
  }
  return value;
}

/**
 * Install drafts in the panel's database. A draft holds the wizard's answers
 * and the uploads it needs. Open, it goes DRAFT_IDLE_MS after its last change,
 * with its uploads. While its install runs it stays; once the install is done
 * it goes, with what is left of its files. A failed install opens it again for
 * DRAFT_IDLE_MS, so it can be changed and run again.
 */
export class Drafts {
  constructor(
    private readonly store: RunStore,
    private readonly uploadsDir: string,
    private readonly now = () => Date.now(),
  ) {}

  private iso = (ms: number) => new Date(ms).toISOString();

  get(id: string): InstallDraft | undefined {
    return this.store.draft(id) as InstallDraft | undefined;
  }

  list(): InstallDraft[] {
    return this.store.drafts() as InstallDraft[];
  }

  /** Saves the wizard's answers; a draft whose install runs is not changed. */
  save(id: string, input: z.infer<typeof draftInput>): InstallDraft {
    if (JSON.stringify(input.state).length > MAX_STATE_BYTES) throw new DraftRefused('The draft is too large to keep');
    const before = this.get(id);
    if (before?.status === 'installing') throw new DraftRefused('Its install is running; follow it on the Jobs page');
    const now = this.now();
    // A dump a job brought in stays until the draft goes; the wizard may not have taken it in yet.
    const attached = before?.attached ?? [];
    // An upload the draft let go of is no longer needed.
    for (const old of before?.uploads ?? []) if (!input.uploads.includes(old) && !attached.includes(old)) removeUpload(this.uploadsDir, old);
    const draft: InstallDraft = {
      id,
      kind: input.kind,
      title: input.title,
      step: input.step,
      state: withoutSecrets(input.state),
      uploads: [...new Set([...input.uploads, ...attached])],
      status: 'open',
      // What the server keeps for the install is not the wizard's to change.
      ...(before?.jobs ? { jobs: before.jobs } : {}),
      ...(before?.results ? { results: before.results } : {}),
      ...(attached.length ? { attached } : {}),
      createdAt: before?.createdAt ?? this.iso(now),
      updatedAt: this.iso(now),
      expiresAt: this.iso(now + DRAFT_IDLE_MS),
    };
    this.store.saveDraft(id, draft);
    return draft;
  }

  /** Throws the draft away with its uploads; one whose install runs stays. */
  discard(id: string): void {
    const draft = this.get(id);
    if (!draft) return;
    if (draft.status === 'installing') throw new DraftRefused('Its install is running; Undo it on the Jobs page first');
    this.drop(draft);
  }

  private drop(draft: InstallDraft): void {
    for (const upload of draft.uploads) removeUpload(this.uploadsDir, upload);
    this.store.deleteDraft(draft.id);
  }

  /** Its install started: it stays as long as the job may need it. */
  installing(id: string, jobId: string): void {
    const draft = this.get(id);
    if (!draft) return;
    const { expiresAt: _gone, ...rest } = draft;
    this.store.saveDraft(id, { ...rest, status: 'installing', jobId, updatedAt: this.iso(this.now()) });
  }

  /** Its install finished: the draft and what is left of its files go. */
  done(id: string): void {
    const draft = this.get(id);
    if (draft) this.drop(draft);
  }

  /** Its install failed or was undone: open again for a while, to change it and run it again. */
  reopen(id: string, status: 'open' | 'failed' = 'failed'): void {
    const draft = this.get(id);
    if (!draft) return;
    const now = this.now();
    this.store.saveDraft(id, { ...draft, status, updatedAt: this.iso(now), expiresAt: this.iso(now + DRAFT_IDLE_MS) });
  }

  /** Drops drafts that ran out, unless their install is still running; returns how many went. */
  sweep(isRunning: (jobId: string) => boolean): number {
    const now = this.now();
    let gone = 0;
    for (const draft of this.list()) {
      if (draft.status === 'installing' && draft.jobId && isRunning(draft.jobId)) continue;
      if (draft.expiresAt && Date.parse(draft.expiresAt) > now) continue;
      // An install the panel lost track of (a restart) counts as run out after the idle time too.
      if (!draft.expiresAt && Date.parse(draft.updatedAt) + DRAFT_IDLE_MS > now) continue;
      this.drop(draft);
      gone += 1;
    }
    return gone;
  }

  /** A dump downloaded for the draft: it holds it from now on, whatever the wizard saves. */
  attach(id: string, upload: string): void {
    const draft = this.get(id);
    if (!draft) return;
    this.store.saveDraft(id, { ...draft, uploads: [...new Set([...draft.uploads, upload])], attached: [...new Set([...(draft.attached ?? []), upload])] });
  }

  /** A dump taken back: the draft no longer holds it. */
  detach(id: string, upload: string): void {
    const draft = this.get(id);
    if (!draft) return;
    const attached = (draft.attached ?? []).filter((u) => u !== upload);
    const { attached: _old, ...rest } = draft;
    this.store.saveDraft(id, { ...rest, uploads: draft.uploads.filter((u) => u !== upload), ...(attached.length ? { attached } : {}) });
  }

  /** The job a step of the install runs now, and for what, so the wizard can follow it after you left the page. */
  noteJob(id: string, step: keyof NonNullable<InstallDraft['jobs']>, jobId: string, key?: string): void {
    const draft = this.get(id);
    if (draft) this.store.saveDraft(id, { ...draft, jobs: { ...draft.jobs, [step]: { id: jobId, ...(key ? { key } : {}) } } });
  }

  /** What a Claude Code step found, kept for the repo or links it was for. */
  saveResult<Step extends keyof NonNullable<InstallDraft['results']>>(id: string, step: Step, result: NonNullable<InstallDraft['results']>[Step]): void {
    const draft = this.get(id);
    if (draft) this.store.saveDraft(id, { ...draft, results: { ...draft.results, [step]: result } });
  }

  /** Uploads drafts still hold, for the upload cleanup to keep. */
  uploadsInUse(): Set<string> {
    return new Set(this.list().flatMap((d) => d.uploads));
  }
}

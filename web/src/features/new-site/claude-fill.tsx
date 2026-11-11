import { gitUrl } from '@devmagic-panel/shared';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Textarea } from '@/components/ui/input';
import { api } from '@/lib/api';
import { Spinner } from '@/components/ui/spinner';
import { type Inspection, type WizardState } from './wizard-shared';
import { applyPreset } from './wizard-state';

// ── Review ───────────────────────────────────────────────────

/**
 * Asks Claude to fill in the wizard from a plain description, the repo, the
 * dump and conventions.md. It only fills the steps; you review them and install.
 */
export function ClaudeFill({ state, setState, cores }: { state: WizardState; setState: (fn: (s: WizardState) => WizardState) => void; cores: string[] }) {
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const repoUrl = state.repoUrl.trim();

  async function fill() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.suggestWizard({
        description: description.trim(),
        ...(gitUrl.safeParse(repoUrl).success ? { repoUrl } : {}),
        ...(state.branch.trim() && state.inspection.status !== 'idle' ? { branch: state.branch.trim() } : {}),
        ...(state.upload ? { uploadId: state.upload.id } : {}),
      });
      setSent(result.sent);
      setState((s) => {
        const next = applyPreset(s, { branch: result.branch, preset: result.preset }, cores);
        const summary = next.inspection.status === 'found' ? next.inspection.summary : '';
        return { ...next, inspection: { status: 'claude', url: s.repoUrl.trim(), branch: result.branch, summary, notes: result.notes } };
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 rounded-lg border border-primary/25 bg-primary/4 p-3">
      <label htmlFor="claude-describe" className="flex items-center gap-1.5 text-sm font-medium"><Sparkles className="size-4 text-primary" />Describe the site to Claude</label>
      <Textarea
        id="claude-describe"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Wandworks main site plus its shop.wandworks.example subdomain, repo above, develop branch. Same setup as BikeTours."
        rows={3}
        disabled={busy}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || description.trim().length < 3} onClick={() => void fill()}>
          {busy ? <Spinner /> : <Sparkles />}
          {busy ? 'Claude is reading...' : 'Fill the wizard'}
        </Button>
        <span className="text-xs text-muted-foreground">Reads conventions.md, the repo's docs, your last install of it, the dump facts and your similar sites. You review every step before Install.</span>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {sent && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">What was sent to Claude</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono whitespace-pre-wrap">{sent}</pre>
        </details>
      )}
    </div>
  );
}

export function ProjectStatus({ inspection }: { inspection: Inspection }) {
  if (inspection.status === 'claude') {
    return (
      <div role="status" className="-mt-2 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/6 px-3 py-2 text-sm">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>
          Filled by Claude on <span className="font-mono text-dense">{inspection.branch}</span>: {inspection.summary}. {inspection.notes} Check every step before you install.
        </span>
      </div>
    );
  }
  if (inspection.status === 'reading') {
    return <p className="-mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" />Reading the repo...</p>;
  }
  if (inspection.status === 'found') {
    return (
      <Notice tone="success" className="-mt-2">
        Filled from your last install of this repo, on <span className="font-mono text-dense">{inspection.branch}</span>: {inspection.summary}. Check the next steps, then install.
      </Notice>
    );
  }
  if (inspection.status === 'none') {
    return <p className="-mt-2 text-xs text-muted-foreground">First install of this repo here. The panel remembers your answers for next time.</p>;
  }
  if (inspection.status === 'error') {
    return <p className="-mt-2 text-xs text-warning">Could not read the repo: {inspection.message}</p>;
  }
  return null;
}

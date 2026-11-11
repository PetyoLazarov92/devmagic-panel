import type { GitTidyPreview } from '@devmagic-panel/shared';
import { GIT_KEEP_DAYS } from '@devmagic-panel/shared';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogList } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { api } from '@/lib/api';
import { bytes, timeAgo } from '@/lib/format';
import { toast } from '@/lib/toast';

type Target = { domain: string; mount?: string; repo?: string };

/** Over this, .git is worth a note that gc cannot shrink history itself. */
const BIG = 500 * 1024 ** 2;

/**
 * Tidy up on the Git card: fetches from origin with prune first, so the
 * branches deleted there show, then lists the local ones whose origin branch
 * is gone (all ticked but the current one) and offers git gc. Deleted
 * branches are kept GIT_KEEP_DAYS days, and the toast's Undo puts them back.
 */
export function GitTidyDialog({ target, label, onClose, onDone }: { target: Target; label: string; onClose: () => void; onDone: (result: { name: string; ok: boolean; output: string }) => void }) {
  const [preview, setPreview] = useState<GitTidyPreview | null>(null);
  const [step, setStep] = useState('Fetching from origin, with prune...');
  const [error, setError] = useState<string | null>(null);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [gc, setGc] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const fetched = await api.runAction('git.fetch', target);
        if (!fetched.ok && live) setFetchNote(`Could not fetch from origin, so this is what was known before: ${fetched.output.trim().split('\n').at(-1) ?? ''}`);
        if (live) setStep('Reading the branches and the size of the repo...');
        const p = await api.gitTidy(target.domain, target.mount, target.repo);
        if (!live) return;
        setPreview(p);
        setTicked(new Set(p.gone.filter((g) => !g.current).map((g) => g.name)));
      } catch (err) {
        if (live) setError((err as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [target.domain, target.mount, target.repo]);

  async function go() {
    setBusy(true);
    const branches = [...ticked];
    try {
      const r = await api.runAction('git.tidy', { ...target, branches, gc });
      onDone({ name: 'Tidy up', ok: r.ok, output: r.output });
      if (r.ok) {
        const deleted = branches.length ? `${branches.length} branch${branches.length === 1 ? '' : 'es'} deleted` : '';
        toast({
          tone: 'success',
          title: [deleted, gc ? 'packed with git gc' : ''].filter(Boolean).join(', ') || 'Fetched with prune',
          ...(branches.length ? { action: { label: 'Undo', run: () => void api.runAction('git.restoreBranches', { ...target, branches }).then((b) => toast({ tone: b.ok ? 'success' : 'danger', title: b.ok ? 'The branches are back' : 'They were not put back' })) } } : {}),
        });
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const unmerged = preview?.gone.filter((g) => ticked.has(g.name) && !g.merged).length ?? 0;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Tidy up the repo (${label})`}
      description="Brings the branches in line with origin and packs the repo. History is never rewritten and the files you work on are not touched."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!preview || busy || (ticked.size === 0 && !gc)} onClick={() => void go()}>
            {busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
            {busy && gc ? 'Packing...' : 'Tidy up'}
          </Button>
        </>
      }
    >
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {!preview && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />{step}</p>}
      {preview && (
        <div className="grid gap-4 text-sm">
          {fetchNote && <p className="rounded-lg bg-warning/8 px-3 py-2 text-xs">{fetchNote}</p>}
          <p>
            Its objects take <span className="font-medium">{bytes(preview.objectsBytes)}</span>, most of <span className="font-mono">.git</span>.
            {preview.objectsBytes > BIG && <span className="text-muted-foreground"> git gc packs them tighter; when the history itself holds big files, gc frees little, and only a new, shallow clone would.</span>}
          </p>
          <div className="grid gap-2">
            <p className="font-medium">Branches here whose branch on origin was deleted ({preview.gone.length})</p>
            {preview.gone.length === 0 ? (
              <p className="text-muted-foreground">None: every local branch with an origin branch still has it.</p>
            ) : (
              <DialogList className="max-h-72 rounded-lg border p-2">
                <ul className="grid gap-1.5">
                {preview.gone.map((g) => (
                  <li key={g.name} className="grid gap-0.5 rounded-md px-2 py-1.5 hover:bg-muted/50">
                    <Checkbox
                      id={`tidy-${g.name.replace(/\W/g, '-')}`}
                      checked={ticked.has(g.name)}
                      disabled={g.current}
                      onChange={(on) => setTicked((t) => {
                        const next = new Set(t);
                        if (on) next.add(g.name);
                        else next.delete(g.name);
                        return next;
                      })}
                      label={
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[13px] break-all">{g.name}</span>
                          {g.current && <Badge tone="warning">current: switch first</Badge>}
                          {g.merged ? <Badge tone="success">in {preview.mainBranch}</Badge> : <Badge>not in {preview.mainBranch ?? 'the default branch'}</Badge>}
                        </span>
                      }
                      hint={<>{g.hash} {g.subject}, {timeAgo(g.date)}</>}
                    />
                  </li>
                ))}
                </ul>
              </DialogList>
            )}
            {unmerged > 0 && (
              <p className="text-xs text-muted-foreground">
                {unmerged} of them {unmerged === 1 ? 'is' : 'are'} not in {preview.mainBranch ?? 'the default branch'}: often a squash merge, sometimes work only here. Each deleted branch is kept {GIT_KEEP_DAYS} days, so Undo puts it back.
              </p>
            )}
          </div>
          <Checkbox id="tidy-gc" checked={gc} onChange={setGc} label="Pack the repo with git gc" hint="Can take a few minutes on a big repo. Keeps git's own way back (the reflog) as it is." />
          {preview.kept.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Kept from earlier tidy-ups: {preview.kept.map((k) => k.name).join(', ')}. The next tidy-up after {GIT_KEEP_DAYS} days lets them go.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

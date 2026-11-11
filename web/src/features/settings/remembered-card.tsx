import type { RememberedRepo, RepoPreset } from '@devmagic-panel/shared';
import { coreVersion, hostname, placementProblems, presetPlacement, repoPreset, repoTarget } from '@devmagic-panel/shared';
import { FolderGit2, Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { PlacementFields } from '@/features/new-site/repo-placement';
import { ScopeLabel } from '@/components/layout/scope-label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { Spinner } from '@/components/ui/spinner';

const urlOf = (r: RememberedRepo) => r.key;

/** A remembered set of answers in a few words: where the repo goes, the others, core, plugins, uploads. */
export function presetSummary(r: RememberedRepo): string[] {
  const p = r.preset;
  if (!p) return ['these answers no longer read: forget them'];
  const where = repoTarget(presetPlacement(p, urlOf(r)));
  return [
    `into ${where || 'the site root'}`,
    p.extra.length ? `${p.extra.length} more repo${p.extra.length === 1 ? '' : 's'}` : '',
    p.core?.mode === 'repo' ? "the repo's own WordPress" : p.core?.version ? `WordPress ${p.core.version}${p.core.mode === 'standalone' ? ', own copy' : ''}` : '',
    p.deactivate.length ? `${p.deactivate.length} plugin${p.deactivate.length === 1 ? '' : 's'} turned off` : '',
    p.uploadsFrom ? `uploads from ${p.uploadsFrom}` : '',
    p.network ? `${p.network.layout} network` : '',
  ].filter(Boolean);
}

/**
 * What the new site wizard remembers per repo, from your last install of it:
 * where each repo went, the core, the plugins turned off, where missing
 * uploads load from. Kept in the panel's database, never in a repo. Change
 * them here, or forget them so the next install starts empty.
 */
export function RememberedCard() {
  const list = useAsync(() => api.rememberedRepos(), []);
  const [editing, setEditing] = useState<RememberedRepo | null>(null);
  const [forgetting, setForgetting] = useState<RememberedRepo | null>(null);
  const [busy, setBusy] = useState(false);

  async function forget(r: RememberedRepo) {
    setBusy(true);
    try {
      await api.forgetRememberedRepo(r.key);
      toast({ tone: 'success', title: `Forgot the answers for ${r.name}` });
      setForgetting(null);
      list.reload();
    } catch (err) {
      toast({ tone: 'danger', title: 'Not forgotten', detail: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Remembered for new installs" meta={<ScopeLabel>new installs of these repos</ScopeLabel>} />
      <CardBody>
        <p className="text-xs text-muted-foreground">
          The wizard fills itself from your last install of a repo: where each repo goes, the core, the plugins it turned off and where missing uploads load from. They live in the panel's database, never in the repo. Domains always come from the dump.
        </p>
        {list.error && <Notice tone="danger" size="inline">{list.error}</Notice>}
        {list.loading && !list.data && <p className="flex items-center gap-2 text-muted-foreground"><Spinner className="size-4" />Reading what the panel remembers...</p>}
        {list.data && list.data.length === 0 && <p className="text-muted-foreground">Nothing yet. A repo's answers are remembered once a site is installed from it.</p>}
        {list.data && list.data.length > 0 && (
          <ul className="grid divide-y rounded-lg border">
            {list.data.map((r) => (
              <li key={r.key} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="grid min-w-0 flex-1 gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-dense font-medium break-all">{r.name}</span>
                    <span className="text-xs text-muted-foreground">last used {timeAgo(r.updatedAt)}</span>
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {presetSummary(r).map((part) => <Badge key={part} tone={r.preset ? undefined : 'warning'}>{part}</Badge>)}
                  </span>
                </div>
                <div className="flex gap-1">
                  {r.preset && (
                    <Button size="sm" variant="soft" onClick={() => setEditing(r)}>
                      <Pencil />
                      Edit
                    </Button>
                  )}
                  <Button size="sm" variant="soft" onClick={() => setForgetting(r)}>
                    <Trash2 />
                    Forget
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      {editing?.preset && <EditDialog repo={editing} preset={editing.preset} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
      <Dialog
        open={forgetting !== null}
        onClose={() => setForgetting(null)}
        title={`Forget the answers for ${forgetting?.name ?? ''}?`}
        description="The next install of this repo starts empty, and remembers its answers again. Sites installed from it stay as they are."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setForgetting(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => forgetting && void forget(forgetting)}>
            {busy && <Spinner />}
            Forget
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

function EditDialog({ repo, preset, onClose, onSaved }: { repo: RememberedRepo; preset: RepoPreset; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<RepoPreset>(() => ({ ...preset, placement: presetPlacement(preset, urlOf(repo)) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placement = draft.placement ?? { dir: '', folder: '' };
  const clash = placementProblems([placement, ...draft.extra])[0] ?? null;
  const uploadsBad = draft.uploadsFrom !== undefined && draft.uploadsFrom !== '' && !hostname.safeParse(draft.uploadsFrom).success;
  const versionBad = draft.core && draft.core.mode !== 'repo' && !coreVersion.safeParse(draft.core.version ?? '').success;
  const site = draft.domains[0]?.local ?? 'the site';

  async function save() {
    const { uploadsFrom, ...rest } = draft;
    const checked = repoPreset.safeParse({ ...rest, ...(uploadsFrom ? { uploadsFrom } : {}) });
    if (!checked.success) {
      setError(checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    setBusy(true);
    try {
      await api.saveRememberedRepo(repo.key, checked.data);
      toast({ tone: 'success', title: `Saved the answers for ${repo.name}` });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      closeOnBackdrop={false}
      title={`Answers for ${repo.name}`}
      description="The next install of this repo starts with these. You still check every step before it installs."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || Boolean(clash) || uploadsBad || Boolean(versionBad)} onClick={() => void save()}>
            {busy && <Spinner />}
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-6 text-sm">
        <section className="grid gap-2">
          <h3 className="font-semibold">Where the repo goes</h3>
          <PlacementFields url={urlOf(repo)} value={placement} onChange={(p) => setDraft((d) => ({ ...d, placement: p }))} site={site} sharedCore={draft.core?.mode === 'wpcore'} problem={clash} />
        </section>
        {draft.extra.length > 0 && (
          <section className="grid gap-3">
            <h3 className="font-semibold">The other repos</h3>
            {draft.extra.map((r, i) => (
              <div key={`${r.url}|${i}`} className="grid gap-3 rounded-lg border p-3">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 font-mono text-dense break-all">{r.url}</span>
                  <Button size="sm" variant="soft" aria-label={`Leave ${r.url} out`} onClick={() => setDraft((d) => ({ ...d, extra: d.extra.filter((_, j) => j !== i) }))}>
                    <X />
                    Leave out
                  </Button>
                </div>
                <PlacementFields url={r.url} value={r} onChange={(p) => setDraft((d) => ({ ...d, extra: d.extra.map((x, j) => (j === i ? { ...x, ...p } : x)) }))} site={site} sharedCore={draft.core?.mode === 'wpcore'} />
              </div>
            ))}
          </section>
        )}
        <section className="grid gap-3 sm:grid-cols-2">
          <Field label="WordPress" htmlFor="remembered-core">
            <Select
              id="remembered-core"
              value={draft.core?.mode ?? ''}
              onChange={(e) => {
                const mode = e.target.value;
                setDraft((d) => {
                  const { core: _old, ...rest } = d;
                  return mode === '' ? rest : { ...rest, core: { mode: mode as 'wpcore' | 'standalone' | 'repo', ...(mode !== 'repo' && d.core?.version ? { version: d.core.version } : {}) } };
                });
              }}
            >
              <option value="">The newest you have</option>
              <option value="wpcore">Shared core</option>
              <option value="standalone">Own copy</option>
              <option value="repo">The repo's own</option>
            </Select>
          </Field>
          {draft.core && draft.core.mode !== 'repo' && (
            <Field label="Version" htmlFor="remembered-version" hint={versionBad ? <span className="text-danger">A version like 7.1.3</span> : undefined}>
              <Input id="remembered-version" value={draft.core.version ?? ''} onChange={(e) => setDraft((d) => ({ ...d, core: { mode: d.core?.mode ?? 'wpcore', version: e.target.value.trim() } }))} className="font-mono text-dense" />
            </Field>
          )}
        </section>
        <Field label="Missing uploads load from" htmlFor="remembered-uploads" hint={uploadsBad ? <span className="text-danger">A host like www.spellbook.example</span> : 'Empty: none.'}>
          <Input id="remembered-uploads" value={draft.uploadsFrom ?? ''} onChange={(e) => setDraft((d) => ({ ...d, uploadsFrom: e.target.value.trim() }))} placeholder="www.spellbook.example" className="font-mono text-dense" />
        </Field>
        <section className="grid gap-2">
          <h3 className="font-semibold">Plugins turned off after the import</h3>
          {draft.deactivate.length === 0 ? (
            <p className="text-xs text-muted-foreground">None.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {draft.deactivate.map((slug) => (
                <li key={slug}>
                  <Button variant="outline" size="xs" onClick={() => setDraft((d) => ({ ...d, deactivate: d.deactivate.filter((s) => s !== slug) }))} className="h-auto gap-1 px-2 py-0.5 font-mono font-normal hover:border-danger/50 hover:bg-card [&_svg]:size-3" aria-label={`Keep ${slug} on`}>
                    {slug}
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

/**
 * Owners whose repos may run here besides your organizations and groups:
 * trusted once from the wizard's Code step, listed here to take back.
 */
export function TrustedOwnersCard() {
  const list = useAsync(() => api.trustedOwners(), []);
  const [busy, setBusy] = useState<string | null>(null);
  async function remove(host: string, owner: string) {
    setBusy(`${host}/${owner}`);
    try {
      await api.untrustOwner(host, owner);
      toast({ tone: 'success', title: `${owner} on ${host} is no longer trusted` });
      list.reload();
    } catch (err) {
      toast({ tone: 'danger', title: 'Not changed', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card>
      <CardHeader title="Trusted repo owners" meta={<ScopeLabel>new installs</ScopeLabel>} />
      <CardBody className="gap-3">
        <p className="text-xs text-muted-foreground">
          Code from a repo runs on this computer: its PHP when the site loads, its composer and npm builds as you. Repos of the organizations and groups you scan, and ones your signed-in GitHub or GitLab CLI lists, may run; any other needs its owner trusted here once, from the wizard.
        </p>
        {list.error && <Notice tone="danger" size="inline">{list.error}</Notice>}
        {list.data && list.data.length === 0 && <p className="text-muted-foreground">None. A pasted repo from another owner asks you first.</p>}
        {list.data && list.data.length > 0 && (
          <ul className="grid divide-y rounded-lg border">
            {list.data.map((t) => (
              <li key={`${t.host}/${t.owner}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1"><span className="font-mono text-dense font-medium">{t.owner}</span> <span className="text-muted-foreground">on {t.host}, trusted {timeAgo(t.at)}</span></span>
                <Button size="sm" variant="soft" disabled={busy === `${t.host}/${t.owner}`} onClick={() => void remove(t.host, t.owner)}>
                  <X />
                  Stop trusting
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

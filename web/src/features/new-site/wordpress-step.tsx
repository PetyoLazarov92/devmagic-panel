import type { DumpPlugin, DumpTheme, RepoBuild } from '@devmagic-panel/shared';
import { repoTarget, coreVersion as coreVersionSchema, DUMP_SCAN_GB, MEDIA_PLUGIN, LOCAL_HELPER_PLUGINS, type LocalHelperPlugin } from '@devmagic-panel/shared';
import { Check, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { IconButton } from '@/components/ui/icon-button';
import { Notice } from '@/components/ui/notice';
import { Input } from '@/components/ui/input';
import { SecretInput } from '@/components/ui/secret-input';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/ui/segmented';
import { ReleaseListLink } from '@/components/layout/release-link';
import { api } from '@/lib/api';
import { type CreateSiteInput, PRODUCTION_ONLY_PLUGINS } from '@/lib/plan';
import { adminCreateOf, dumpAdmins } from '@/lib/admin-choice';
import { type BuildPick, buildChoice, buildId } from '@/lib/builds';
import { pluginMatches } from '@/lib/plugin-search';
import { useAsync } from '@/lib/use-async';
import { placementOf, rowPlacement } from '@/lib/project-repos';
import { askWporg, defaultPick, defaultThemePick, onServer, pluginChoices, type PluginPick, pluginSlug, themeChoices, type ThemePick } from '@/lib/missing-plugins';
import { cn } from '@/lib/utils';
import { type Setter, type WizardState } from './wizard-shared';
import { adminDefaults, cleanAddress, missingOf, missingThemesOf, uploadsDefault, uploadsViaFor } from './wizard-state';

// ── WordPress ────────────────────────────────────────────────

export const OTHER_VERSION = 'other';

/** 7.1.3 before 7.0.4 before 6.8.10 before 6.8.9. */
export function newerFirst(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function WordPressStep({ state, set, cores, input, uploadsError }: { state: WizardState; set: Setter; cores: string[]; input: CreateSiteInput; uploadsError: string | null }) {
  // The production address the repo's docs give, offered when the dump names none.
  const docsProduction = state.org?.prefill?.productionHint;
  const defaults = adminDefaults(state, input.domain);
  const isRepo = state.source === 'repo';
  const toggle = (slug: string, on: boolean) => set('deactivate', on ? [...state.deactivate, slug] : state.deactivate.filter((s) => s !== slug));
  const active = state.upload?.facts.activePlugins;
  const productionOnly = new Set<string>(PRODUCTION_ONLY_PLUGINS);
  // Production-only ones first; a preset may name plugins this dump does not list, so they stay visible.
  const deactivatable = [...new Set([...(active ? [...active].sort((a, b) => Number(productionOnly.has(b)) - Number(productionOnly.has(a))) : PRODUCTION_ONLY_PLUGINS), ...state.deactivate])];
  // A dump with many plugins gets a search over both plugin lists; ticks stay as they are while rows are hidden.
  const [find, setFind] = useState('');
  const searchable = deactivatable.length > PLUGIN_SEARCH_FROM;
  const query = searchable ? find : '';
  const found = deactivatable.filter((slug) => pluginMatches(slug, query));
  const ticked = deactivatable.filter((slug) => state.deactivate.includes(slug)).length;
  // Installed cores, plus WordPress.org's newest when it is not: that one is added on the way.
  const report = useAsync(() => api.coresReport().catch(() => null), []);
  const latest = report.data?.latest;
  const versions = [...new Set([...cores, ...(latest ? [latest] : [])])].sort(newerFirst);
  // Other version: a field for any exact number, which stays open while you type (an empty one is not filled for you).
  const [otherPicked, setOtherPicked] = useState(false);
  const other = otherPicked || (state.coreVersion !== '' && !versions.includes(state.coreVersion)) || versions.length === 0;
  useEffect(() => {
    if (!otherPicked && state.coreVersion === '' && latest) set('coreVersion', latest);
  }, [latest, state.coreVersion, otherPicked]);
  const addedNote = state.coreMode === 'wpcore' ? 'added to the shared cores' : 'downloaded';
  // A repo with core of its own runs on it: no shared core, no download.
  const repoCore = isRepo && state.helpers?.core ? state.helpers.core : null;
  const via = uploadsViaFor(state);
  const uploadsOn = Boolean(input.uploadsFrom);
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="grid h-fit gap-4">
        <h2 className="text-sm font-semibold">Core</h2>
        {repoCore && (
          <Notice tone="warning" size="inline">
            The repo holds WordPress core{repoCore.version ? ` (${repoCore.version})` : ''}, so the site uses it as it is. Keeping core in git is unusual, but fine when the repo patches it on purpose.
          </Notice>
        )}
        <div role="radiogroup" aria-label="Core" className="grid gap-2">
          {(repoCore
            ? ([['repo', "The repo's own WordPress", `Used as it is${repoCore.version ? `, WordPress ${repoCore.version}` : ''}: no shared core and no download, so core files never mix with the repo's.`]] as const)
            : ([
                ['wpcore', 'Shared core (recommended)', 'Symlinked to the shared cores folder; switch versions in seconds.'],
                ['standalone', 'Own copy', 'Downloads WordPress into the site folder.'],
              ] as const)
          ).map(([value, label, hint]) => (
            <label key={value} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm', state.coreMode === value && 'border-primary bg-primary/5')}>
              <input type="radio" name="core" checked={state.coreMode === value} onChange={() => set('coreMode', value)} className="mt-0.5 accent-[var(--primary)]" />
              <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
            </label>
          ))}
        </div>
        {!repoCore && <Field
          label="Version"
          htmlFor="version"
          hint={
            <>
              {versions.length === 0 && 'No shared cores yet and WordPress.org could not be asked: type a version. '}
              {other && state.coreVersion !== '' && !coreVersionSchema.safeParse(state.coreVersion).success && <span className="text-danger">A version like 6.8.3. </span>}
              {state.coreVersion && !cores.includes(state.coreVersion) && state.coreMode === 'wpcore' && `WordPress ${state.coreVersion} is added to the shared cores first. `}
              <ReleaseListLink />
            </>
          }
        >
          <Select
            id="version"
            value={other ? OTHER_VERSION : state.coreVersion}
            onChange={(e) => {
              const picked = e.target.value === OTHER_VERSION;
              setOtherPicked(picked);
              set('coreVersion', picked ? '' : e.target.value);
            }}
          >
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
                {v === latest ? ' (latest)' : ''}
                {cores.includes(v) ? '' : ` (${addedNote})`}
              </option>
            ))}
            <option value={OTHER_VERSION}>Other version...</option>
          </Select>
          {other && (
            <Input
              id="version-other"
              autoFocus={otherPicked}
              aria-label="Other version"
              value={state.coreVersion}
              onChange={(e) => set('coreVersion', e.target.value.trim())}
              placeholder="An exact release, like 6.8.3"
              className="font-mono text-dense"
              spellCheck={false}
              aria-invalid={state.coreVersion !== '' && !coreVersionSchema.safeParse(state.coreVersion).success ? true : undefined}
            />
          )}
        </Field>}

        <AdminSection state={state} set={set} input={input} defaults={defaults} />
      </section>

      <section className="grid h-fit gap-4">
        {state.source === 'repo' && !state.noDump && (
          <>
            {searchable && <PluginSearch value={find} onChange={setFind} found={found.length} total={deactivatable.length} ticked={ticked} />}
            <h2 className="text-sm font-semibold">Deactivate after import</h2>
            <p className="-mt-2 text-xs text-muted-foreground">
              {active ? 'The plugins active in the dump. Tick the ones to turn off locally.' : 'The dump does not say which plugins are active, so these are the usual production-only ones. Only active ones are touched.'}
              {state.inspection.status === 'found' && state.deactivate.length > 0 && ' Ticked: the ones you turned off on your last install of this repo.'}
            </p>
            {query.trim() && found.length === 0 && <p className="text-sm text-muted-foreground">No active plugin matches the search.</p>}
            <div className="grid gap-2.5 sm:grid-cols-2">
              {found.map((slug) => {
                // One choice per plugin: a helper you turn on below, or the plugin loading the images, is not also turned off.
                const keptOn = (state.activate as string[]).includes(slug) ? 'Set to turn on under Local helpers' : slug === MEDIA_PLUGIN && via === 'plugin' && uploadsOn ? 'Loads the missing images, see Uploads' : null;
                return (
                  <Checkbox
                    key={slug}
                    id={`p-${slug}`}
                    checked={!keptOn && state.deactivate.includes(slug)}
                    onChange={(v) => toggle(slug, v)}
                    disabled={Boolean(keptOn)}
                    label={<code className="font-mono text-dense">{slug}</code>}
                    hint={keptOn ?? (active && productionOnly.has(slug) ? 'Usually production only' : undefined)}
                  />
                );
              })}
            </div>

            <MissingPluginsSection state={state} set={set} />

            <HelpersSection state={state} set={set} query={query} />

            <h2 className="mt-2 text-sm font-semibold">Load missing images from production</h2>
            {state.helpers?.media && (
              <div role="radiogroup" aria-label="How missing images load" className="grid gap-2">
                {([
                  ['plugin', 'BE Media from Production', 'The repo has it: the panel sets BE_MEDIA_FROM_PRODUCTION_URL in wp-config.php (unless it is there already) and turns the plugin on.'],
                  ['redirect', 'Redirect in the vhost', 'The panel\'s vhost (Local mode for a site under a path) sends a missing file under wp-content/uploads to the same path there.'],
                ] as const).map(([value, label, hint]) => (
                  <label key={value} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm', via === value && 'border-primary bg-primary/5')}>
                    <input type="radio" name="uploads-via" checked={via === value} onChange={() => set('uploadsVia', value)} className="mt-0.5 accent-[var(--primary)]" />
                    <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
                  </label>
                ))}
              </div>
            )}
            <Field
              label="Production domain"
              htmlFor="uploads-from"
              hint={uploadsError ? <span className="text-danger">{uploadsError}</span> : 'The production domain, with www. when the live site has it. Empty: missing images stay missing. A local address in the dump is never filled in here.'}
            >
              <Input
                id="uploads-from"
                value={state.uploadsFrom ?? uploadsDefault(state)}
                onChange={(e) => set('uploadsFrom', e.target.value)}
                onBlur={() => set('uploadsFrom', cleanAddress(state.uploadsFrom ?? uploadsDefault(state), false))}
                placeholder="www.example.com"
                aria-invalid={uploadsError ? true : undefined}
                className={cn('font-mono text-dense', uploadsError && 'border-danger')}
                spellCheck={false}
              />
              {/* A dump that is already a local copy names no production domain; the docs may. */}
              {docsProduction && !(state.uploadsFrom ?? uploadsDefault(state)) && (
                <Button size="xs" variant="soft" className="justify-self-start" onClick={() => set('uploadsFrom', docsProduction)}>
                  Use <span className="font-mono">{docsProduction}</span>, from the repo's docs
                </Button>
              )}
            </Field>
            {/* The files themselves, only when asked: the server the dump was exported from has them. */}
            {state.serverFrom && state.upload && !state.noDump && (
              <div className="grid gap-2 rounded-lg border px-3 py-2.5 text-sm">
                <label htmlFor="copy-uploads" className="flex cursor-pointer items-start gap-2.5">
                  <input id="copy-uploads" type="checkbox" checked={Boolean(state.copyUploads)} onChange={(e) => set('copyUploads', e.target.checked)} className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-input accent-[var(--primary)]" />
                  <span>
                    <span className="font-medium">Also copy the uploads from {state.serverFrom.host}</span>
                    <span className="block text-xs text-muted-foreground">Off by default: missing images already load from production. Tick it to have the files on this disk, for work offline or on the images themselves. It reads only on the server, with rsync, and can take a while.</span>
                  </span>
                </label>
                {state.copyUploads && (
                  <>
                    <Segmented
                      label="How much of the uploads"
                      value={String(state.uploadsMonths ?? 0)}
                      onChange={(v) => set('uploadsMonths', Number(v) || null)}
                      options={[['3', 'Last 3 months'], ['12', 'Last 12 months'], ['0', 'All of them']]}
                      className="justify-self-start"
                    />
                    <p className="text-xs text-muted-foreground">
                      The install checks the size against this disk first and stops the copy when all of them would not fit. PHP files, links and the cache, log and backup folders of plugins stay on the server.
                    </p>
                  </>
                )}
              </div>
            )}

            <BuildSection state={state} set={set} />
          </>
        )}
      </section>
    </div>
  );
}

/**
 * The admin user. When the scan read the dump's users, it names its admins
 * and one-click login signs you in as the first; an admin for this copy is
 * made only when you switch it on (on by default when the dump has none). A
 * dump it could not read keeps the two choices. Fresh WordPress always makes one.
 */
export function AdminSection({ state, set, input, defaults }: { state: WizardState; set: Setter; input: CreateSiteInput; defaults: { user: string; password: string; email: string } }) {
  // A project without a dump gets its admin from the fresh install, as a fresh WordPress does.
  const isRepo = state.source === 'repo' && !state.noDump;
  const found = dumpAdmins(state);
  const network = Boolean(state.upload?.facts.multisite);
  const create = adminCreateOf(state);
  const user = (state.adminUser ?? defaults.user).trim();
  const fields = (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Username" htmlFor="admin" hint={isRepo ? undefined : 'One-click login from the panel signs you in as this user.'}>
        <Input id="admin" value={state.adminUser ?? defaults.user} onChange={(e) => set('adminUser', e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Email" htmlFor="email">
        <Input id="email" type="email" value={state.adminEmail ?? defaults.email} onChange={(e) => set('adminEmail', e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Password" htmlFor="admin-secret" hint="For this local copy only: logins work from this computer alone.">
        <SecretInput id="admin-secret" value={state.adminPassword ?? defaults.password} onChange={(e) => set('adminPassword', e.target.value)} />
      </Field>
    </div>
  );
  const title = (
    <>
      <h2 className="mt-2 text-sm font-semibold">Admin user</h2>
      {isRepo && state.cleanCopy && (
        <p className="text-sm text-muted-foreground">
          The copy is cleaned after the import, so this is the only user it keeps: {dumpAdmins(state)?.some((l) => l.toLowerCase() === user.toLowerCase()) && !adminCreateOf(state) ? "the dump's own administrator, as it is" : 'made with this password'}, the author of every post.
        </p>
      )}
    </>
  );
  if (!isRepo) return <>{title}{fields}</>;
  if (!found) {
    return (
      <>
        {title}
        {state.upload && (
          <p className="text-sm text-muted-foreground">
            {state.upload.facts.partial
              ? `The dump's admins are not known: the panel reads the first ${DUMP_SCAN_GB} GB of a dump and its users come later.`
              : "The dump's admins are not known: its users could not be read."}{' '}
            Choose what happens to this user.
          </p>
        )}
        {fields}
        <div className="grid gap-3 text-sm">
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-sm font-medium">When the database has {input.admin?.user || 'this user'} already</legend>
            {([
              ['keep', 'Leave it as it is', 'Its password and role stay; one-click login still works.'],
              ['update', 'Set this password and make it an administrator', undefined],
            ] as const).map(([value, label, hint]) => (
              <label key={value} className="flex cursor-pointer items-start gap-2.5">
                <input type="radio" name="admin-exists" checked={state.adminIfExists === value} onChange={() => set('adminIfExists', value)} className="mt-0.5 accent-[var(--primary)]" />
                <span>{label}{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</span>
              </label>
            ))}
          </fieldset>
          <Checkbox
            id="admin-create"
            checked={state.adminIfMissing === 'create'}
            onChange={(v) => set('adminIfMissing', v ? 'create' : 'skip')}
            label={`Create ${input.admin?.user || 'it'} when the database does not have it`}
            hint={state.adminIfMissing === 'skip' ? 'No user is added; one-click login signs you in as the first administrator.' : undefined}
          />
        </div>
      </>
    );
  }
  const taken = found.some((login) => login.toLowerCase() === user.toLowerCase());
  return (
    <>
      {title}
      {found.length > 0 ? (
        <div className="grid gap-1.5 rounded-lg border bg-card p-3 text-sm">
          <p className="font-medium">{network ? 'Super admins in the dump' : 'Admin users in the dump'}</p>
          <p className="flex flex-wrap gap-1.5">{found.map((login) => <Badge key={login} className="font-mono text-xs">{login}</Badge>)}</p>
          <p className="text-xs text-muted-foreground">Log in with one click signs you in as <code className="font-mono">{found[0]}</code>.</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">The dump has no {network ? 'super admin' : 'administrator'}, so this copy gets one.</p>
      )}
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Create an admin user for this copy</p>
          <p className="text-xs text-muted-foreground">{create ? 'With the name and password below.' : 'No user is touched.'}</p>
        </div>
        <Switch checked={create} label="Create an admin user for this copy" onChange={(on) => set('adminCreate', on)} />
      </div>
      {create && fields}
      {create && (taken ? (
        <Notice tone="warning">
          <code className="font-mono">{user}</code> is in the dump: its password changes to this one and it stays an administrator.
        </Notice>
      ) : (
        <p className="text-xs text-muted-foreground">A new administrator next to the ones in the dump.</p>
      ))}
    </>
  );
}

/** Rows of the right height while the repo lookup reads, so the column does not jump when it answers. */
export function Placeholders({ rows }: { rows: number }) {
  return (
    <div className="grid gap-2.5" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-2.5">
          <span className="mt-0.5 size-4 shrink-0 animate-pulse rounded bg-muted" />
          <span className="grid flex-1 gap-1.5">
            <span className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
            <span className="h-3 w-3/5 animate-pulse rounded bg-muted/70" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The local helpers to turn on: the ones the branch holds (a plugin folder,
 * or required from WordPress Packagist in composer.json). One the dump has
 * on stays on; when the repo cannot be read, only those are kept.
 */
/** More plugins than this in the dump and the WordPress step offers a search. */
export const PLUGIN_SEARCH_FROM = 8;

/**
 * Finds plugins in Deactivate after import and Activate after import at once:
 * only the matching rows show, ticked or not, and Clear or Escape shows them all.
 */
export function PluginSearch({ value, onChange, found, total, ticked }: { value: string; onChange: (v: string) => void; found: number; total: number; ticked: number }) {
  return (
    <div className="grid gap-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && value) {
              e.preventDefault();
              onChange('');
            }
          }}
          placeholder="Find a plugin to deactivate or activate"
          aria-label="Find a plugin to deactivate or activate"
          spellCheck={false}
          autoComplete="off"
          className="pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
        />
        {value && (
          <IconButton icon={X} label="Clear the search" onClick={() => onChange('')} className="absolute top-1/2 right-1.5 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground [&_svg]:size-3.5" />
        )}
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {value.trim() ? `${found} of ${total} plugins match` : `${total} plugins`}
        {ticked > 0 && ` · ${ticked} set to deactivate`}
      </p>
    </div>
  );
}

/**
 * Plugins the dump has that no repo brings: active ones on WordPress.org are
 * installed after the import unless you choose otherwise, others can be
 * turned off or left (WordPress turns a missing active plugin off itself).
 * Inactive ones production had installed can be installed too.
 */
export function MissingPluginsSection({ state, set }: { state: WizardState; set: Setter }) {
  const { missing, reading } = missingOf(state);
  const unknown = [...new Set(missing.map(pluginSlug))].filter((slug) => !(slug in state.wporg));
  const [asking, setAsking] = useState(false);
  // WordPress.org gave no answer for some: said, with a way to ask again, never a line that waits forever.
  const [unanswered, setUnanswered] = useState(false);
  const ask = () => {
    if (unknown.length === 0 || asking) return;
    setAsking(true);
    setUnanswered(false);
    void askWporg(unknown, api.wporgPlugins)
      .then(({ answers, failed }) => {
        set('wporg', { ...state.wporg, ...answers });
        setUnanswered(failed);
      })
      .finally(() => setAsking(false));
  };
  useEffect(ask, [unknown.join('|')]);
  // The themes the dump's sites use that no repo brings, asked about the same way.
  const themes = missingThemesOf(state);
  const wporgThemes = state.wporgThemes ?? {};
  const unknownThemes = themes.map((t) => t.name).filter((name) => !(name in wporgThemes));
  useEffect(() => {
    if (unknownThemes.length === 0) return;
    void askWporg(unknownThemes, api.wporgThemes).then(({ answers }) => set('wporgThemes', { ...wporgThemes, ...answers }));
  }, [unknownThemes.join('|')]);
  // What WordPress.org does not have may be on the server the dump came from: read once, only then.
  const from = state.serverFrom ?? null;
  const notOnWporg = missing.some((p) => state.wporg[pluginSlug(p)] === null) || themes.some((t) => wporgThemes[t.name] === null);
  const [readingServer, setReadingServer] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const readServer = () => {
    if (!from || readingServer) return;
    setReadingServer(true);
    setServerError(null);
    void api.serverFiles(from.host, from.folder, state.serverSecret || undefined, from.wpCli)
      .then((has) => set('serverHas', has), (error: Error) => setServerError(error.message))
      .finally(() => setReadingServer(false));
  };
  useEffect(() => {
    if (from && notOnWporg && !state.serverHas && !serverError) readServer();
  }, [from?.host, from?.folder, notOnWporg, Boolean(state.serverHas)]);
  if (!state.upload?.facts.plugins) return null;
  const pick = (file: string, p: PluginPick) => set('pluginPicks', { ...state.pluginPicks, [file]: p });
  const active = missing.filter((p) => p.active);
  const inactive = missing.filter((p) => !p.active);
  const copies = pluginChoices(missing, state.pluginPicks, state.wporg, state.rememberedPlugins, state.serverHas).copy.length + themeChoices(themes, state.themePicks ?? {}, wporgThemes, state.serverHas).copy.length;
  const themeRow = (t: DumpTheme) => {
    const wp = wporgThemes[t.name];
    const there = state.serverHas?.themes.find((x) => x.name === t.name);
    const value = state.themePicks?.[t.name] ?? defaultThemePick(t, wp, state.serverHas);
    const options: Array<[ThemePick, string]> = [
      ...(wp ? ([['install', 'Install']] as Array<[ThemePick, string]>) : []),
      ...(there && from ? ([['server', 'Copy from the server']] as Array<[ThemePick, string]>) : []),
      ['leave', "Don't install"],
    ];
    return (
      <li key={t.name} className="grid gap-1.5 rounded-lg border px-3 py-2.5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{wp?.name ?? t.name}</span>
          <code className="font-mono text-xs text-muted-foreground">wp-content/themes/{t.name}</code>
          {t.parent ? <Badge>parent of the active theme</Badge> : <Badge tone="warning">active{t.sites !== undefined && t.sites > 1 ? ` on ${t.sites} sites` : ''}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          {wp === undefined
            ? 'Asking WordPress.org...'
            : wp
              ? `On WordPress.org${t.version ? `: installs ${t.version}, production's version (latest ${wp.version})` : `, latest ${wp.version}`}.`
              : there && from
                ? `Not on WordPress.org: a paid or custom theme. ${from.host} has it${there.version ? `, version ${there.version}` : ''}: it can be copied from there, reading only.`
                : 'Not on WordPress.org: a paid or custom theme. Without it WordPress shows a blank page or falls back to a default theme: add its repo on the Code step, or get it from production.'}
        </p>
        <Segmented label={`What to do with the theme ${t.name}`} value={value} onChange={(v) => set('themePicks', { ...(state.themePicks ?? {}), [t.name]: v })} options={options} className="justify-self-start" />
      </li>
    );
  };
  const row = (p: DumpPlugin) => {
    const slug = pluginSlug(p);
    const wp = state.wporg[slug];
    const there = onServer(p, state.serverHas);
    const value = state.pluginPicks[p.file] ?? defaultPick(p, wp, state.rememberedPlugins, state.serverHas);
    const options: Array<[PluginPick, string]> = [
      ...(wp ? ([['install', 'Install']] as Array<[PluginPick, string]>) : []),
      ...(there && from ? ([['server', 'Copy from the server']] as Array<[PluginPick, string]>) : []),
      ...(p.active ? ([['off', 'Turn off']] as Array<[PluginPick, string]>) : []),
      ['leave', "Don't install"],
    ];
    return (
      <li key={p.file} className="grid gap-1.5 rounded-lg border px-3 py-2.5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{wp?.name ?? slug}</span>
          <code className="font-mono text-xs text-muted-foreground">{p.file}</code>
          {p.network && <Badge>network</Badge>}
          {p.sites !== undefined && p.sites > 1 && <Badge>{p.sites} sites</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          {wp === undefined
            ? asking ? 'Asking WordPress.org...' : 'WordPress.org did not answer for this one, so it cannot be installed yet.'
            : wp
              ? `On WordPress.org${p.version ? `: installs ${p.version}, production's version (latest ${wp.version})` : `, latest ${wp.version}`}.`
              : there && from
                ? `Not on WordPress.org: a premium or custom plugin. ${from.host} has it${there.version ? `, version ${there.version}` : ''}: it can be copied from there, reading only.`
                : from && readingServer
                  ? `Not on WordPress.org: a premium or custom plugin. Asking ${from.host} whether it has it...`
                  : 'Not on WordPress.org: a premium or custom plugin. Get it from its vendor or from production, or turn it off.'}
        </p>
        <Segmented label={`What to do with ${slug}`} value={value} onChange={(v) => pick(p.file, v)} options={options} className="justify-self-start" />
      </li>
    );
  };
  return (
    <>
      <h2 className="mt-2 text-sm font-semibold">Missing plugins</h2>
      {reading ? (
        <p className="-mt-2 text-xs text-muted-foreground">Comparing the dump's plugins with what the repos bring...</p>
      ) : missing.length === 0 ? (
        <p className="-mt-2 text-xs text-muted-foreground">The repos bring every plugin the dump has.</p>
      ) : (
        <>
          <p className="-mt-2 text-xs text-muted-foreground">
            In the dump, but in none of the repos. Installed from WordPress.org after the import, one at a time: one that fails is noted and the rest go on. They are kept out of git locally.
          </p>
          {unanswered && !asking && (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-warning">
              WordPress.org did not answer for some plugins, so they are not set to install.
              <Button size="sm" variant="outline" onClick={ask}><RefreshCw />Ask again</Button>
            </p>
          )}
          {serverError && from && (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-warning">
              Could not read the plugins on {from.host}, so none is set to be copied from there: {serverError}
              <Button size="sm" variant="outline" onClick={readServer}><RefreshCw />Ask again</Button>
            </p>
          )}
          {from && copies > 0 && (
            <p className="text-xs text-muted-foreground">
              {copies} {copies === 1 ? 'is' : 'are'} copied from {from.host} over SSH after the import: tar reads the folder there and nothing is written on the server. What arrives is checked before it is unpacked and kept out of git locally.
              {!state.serverSecret && ' A server that asks for a password gets the one you gave for the dump during this visit; after a reload, copy them on the site\'s Plugins tab instead.'}
            </p>
          )}
          {active.length > 0 && <ul className="grid gap-2">{active.map(row)}</ul>}
          {inactive.length > 0 && (
            <details className="rounded-lg border bg-card px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium">Installed on production, not active ({inactive.length})</summary>
              <ul className="mt-3 grid gap-2">{inactive.map(row)}</ul>
            </details>
          )}
        </>
      )}
      {themes.length > 0 && (
        <>
          <h2 className="mt-2 text-sm font-semibold">Missing themes</h2>
          <p className="-mt-2 text-xs text-muted-foreground">The dump's sites use {themes.length === 1 ? 'this theme' : 'these themes'}, and none of the repos brings {themes.length === 1 ? 'it' : 'them'}. Installed after the import, never activated: the database already says which theme is on.</p>
          <ul className="grid gap-2">{themes.map(themeRow)}</ul>
        </>
      )}
    </>
  );
}

export function HelpersSection({ state, set, query }: { state: WizardState; set: Setter; query: string }) {
  // The helpers any repo of the site has; the main repo's lookup says when the list is read.
  const helpers = state.helpers?.list ? { ...state.helpers, list: [...new Set([...state.helpers.list, ...state.extra.flatMap((r) => r.helpers?.list ?? [])])] } : state.helpers;
  const active = new Set(state.upload?.facts.activePlugins ?? []);
  const list = helpers?.list?.filter((slug) => pluginMatches(slug, query));
  const toggle = (slug: LocalHelperPlugin, on: boolean) => set('activate', on ? [...state.activate, slug] : state.activate.filter((s) => s !== slug));
  const onInDump = (slug: string) => (
    <p key={slug} className="flex items-start gap-2.5 text-sm">
      <Check className="mt-0.5 size-4 shrink-0 text-success" />
      <span><code className="font-mono text-dense">{slug}</code><span className="block text-xs text-muted-foreground">{state.deactivate.includes(slug) ? 'On in the dump; set to deactivate above' : 'On in the dump: it stays on'}</span></span>
    </p>
  );
  const dumpHelpers = (Object.keys(LOCAL_HELPER_PLUGINS) as LocalHelperPlugin[]).filter((slug) => active.has(slug) && pluginMatches(slug, query));
  return (
    <>
      <h2 className="mt-2 text-sm font-semibold">Activate after import</h2>
      {!helpers || (!helpers.list && !helpers.error) ? (
        <>
          <p className="-mt-2 text-xs text-muted-foreground">Looking for the local helpers in the repo...</p>
          <Placeholders rows={2} />
        </>
      ) : helpers.error ? (
        <>
          <p className="-mt-2 text-xs text-warning">Could not read the repo's plugins, so nothing new is turned on: {helpers.error}</p>
          {dumpHelpers.length > 0 && <div className="grid gap-2.5">{dumpHelpers.map(onInDump)}</div>}
        </>
      ) : helpers.list?.length === 0 ? (
        <p className="-mt-2 text-xs text-muted-foreground">None of the local helpers are in this repo or its composer.json.</p>
      ) : (
        <>
          <p className="-mt-2 text-xs text-muted-foreground">The local helpers this branch has, as a plugin folder or in composer.json. Tick the ones to turn on; nothing is downloaded.</p>
          {query.trim() && list?.length === 0 && <p className="text-sm text-muted-foreground">No local helper matches the search.</p>}
          <div className="grid gap-2.5">
            {list?.map((slug) =>
              active.has(slug) ? (
                onInDump(slug)
              ) : (
                <Checkbox
                  key={slug}
                  id={`h-${slug}`}
                  checked={!state.deactivate.includes(slug) && state.activate.includes(slug)}
                  onChange={(v) => toggle(slug, v)}
                  disabled={state.deactivate.includes(slug)}
                  label={<code className="font-mono text-dense">{slug}</code>}
                  hint={state.deactivate.includes(slug) ? 'Set to deactivate above; untick it there to turn it on here' : LOCAL_HELPER_PLUGINS[slug]}
                />
              ),
            )}
          </div>
        </>
      )}
    </>
  );
}

/**
 * The build checklist: every composer.json and package.json the repo lookup
 * found, ticked only where the repo does not hold what it makes. Most ship
 * their built files, so those wait closed below. The docs of an organization
 * install can tick a row and pick its script.
 */
export function BuildSection({ state, set }: { state: WizardState; set: Setter }) {
  const helpers = state.helpers;
  const commands = state.org?.read.facts?.buildCommands ?? [];
  const docsFile = state.org?.read.facts?.sources.find((s) => s.field === 'buildCommands')?.file ?? 'the docs';
  const builds = helpers?.builds;
  // The other repos' builds, each under its name; their picks are kept on their own row.
  const others = state.extra.filter((r) => r.helpers?.builds?.length);
  return (
    <>
      <h2 className="mt-2 text-sm font-semibold">Build</h2>
      {!helpers || (!helpers.list && !helpers.error) ? (
        <>
          <p className="-mt-2 text-xs text-muted-foreground">Reading the repo's composer.json and package.json files...</p>
          <Placeholders rows={2} />
        </>
      ) : !builds ? (
        <>
          <p className="-mt-2 text-xs text-warning">Could not read the repo's build files, so these run at the repo root when they are there.</p>
          <div className="grid gap-2.5">
            <Checkbox id="composer" checked={state.composer} onChange={(v) => set('composer', v)} label={<>Run <code className="font-mono">composer install</code></>} hint="When a composer.json is found" />
            <Checkbox id="npm" checked={state.npm} onChange={(v) => set('npm', v)} label={<>Run <code className="font-mono">npm ci && npm run build</code></>} hint="When a package.json with a build script is found" />
          </div>
        </>
      ) : builds.length === 0 && others.length === 0 ? (
        <p className="-mt-2 text-xs text-muted-foreground">No composer.json or package.json in the repos has something to build.</p>
      ) : (
        <>
          <p className="-mt-2 text-xs text-muted-foreground">Ticked where a repo does not hold what the build makes. Each runs in its folder, as you, after the clones.</p>
          {builds.length > 0 && (
            <BuildRows prefix="main" title={others.length ? `${state.org?.repo?.fullName ?? 'The main repo'}, at ${repoTarget(placementOf(state)) || 'the site root'}` : null} builds={builds} picks={state.buildPicks} commands={commands} docsFile={docsFile} nodes={state.helpers?.nodes ?? []} onPick={(picks) => set('buildPicks', picks)} />
          )}
          {others.map((r) => (
            <BuildRows
              key={r.url}
              prefix={r.url}
              title={`${r.fullName ?? r.url}, in ${repoTarget(rowPlacement(r)) || 'the site root'}`}
              builds={r.helpers?.builds ?? []}
              picks={r.buildPicks}
              commands={[]}
              docsFile=""
              nodes={r.helpers?.nodes ?? []}
              onPick={(picks) => set('extra', state.extra.map((x) => (x.url === r.url ? { ...x, buildPicks: picks } : x)))}
            />
          ))}
        </>
      )}
    </>
  );
}

/** One repo's builds: the ones it needs ticked, the ones it ships built folded away. */
export function BuildRows({ prefix, title, builds, picks, commands, docsFile, nodes, onPick }: {
  prefix: string;
  /** The Nodes nvm has: a build can be put on one of them. */
  nodes: string[];
  title: string | null;
  builds: RepoBuild[];
  picks: Record<string, BuildPick>;
  commands: Parameters<typeof buildChoice>[2];
  docsFile: string;
  onPick: (picks: Record<string, BuildPick>) => void;
}) {
  const pick = (build: RepoBuild, patch: BuildPick) => onPick({ ...picks, [buildId(build)]: { ...buildChoice(build, picks, commands), ...patch } });
  /** Puts a build on one Node, or back on the one the panel picks. */
  const pickNode = (build: RepoBuild, node: string) => {
    const { node: _was, fromDocs: _docs, ...rest } = buildChoice(build, picks, commands);
    onPick({ ...picks, [buildId(build)]: { ...rest, ...(node ? { node } : {}) } });
  };
  const row = (build: RepoBuild) => {
    const choice = buildChoice(build, picks, commands);
    const id = `b-${`${prefix}-${buildId(build)}`.replace(/[^\w-]/g, '-')}`;
    const install = build.tool === 'composer' ? 'composer install' : build.tool === 'npm' ? 'npm ci' : `${build.tool} install`;
    return (
      <div key={id} className="flex items-start gap-2.5 text-sm">
        <input id={id} type="checkbox" checked={choice.on} onChange={(e) => pick(build, { on: e.target.checked })} className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-input accent-[var(--primary)]" />
        <div className="grid min-w-0 flex-1 gap-1">
          <label htmlFor={id} className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1">
            <code className="font-mono text-dense">{install}</code>
            {build.tool !== 'composer' && <span className="text-muted-foreground">then</span>}
            {choice.fromDocs && <Badge tone="primary">from {docsFile}</Badge>}
          </label>
          {build.tool !== 'composer' && (
            <Select aria-label={`Script to run in ${build.dir || 'the repo root'}`} value={choice.script ?? ''} onChange={(e) => pick(build, { on: true, script: e.target.value })} className="h-8 font-mono text-dense" wrapClassName="max-w-64">
              {!choice.script && <option value="">Pick a script</option>}
              {build.scripts.map((name) => (
                <option key={name} value={name} disabled={Boolean(build.missingTasks?.[name])}>
                  {`${build.tool} run ${name}${build.missingTasks?.[name] ? ` (no gulp task ${build.missingTasks[name]})` : ''}`}
                </option>
              ))}
            </Select>
          )}
          {build.tool !== 'composer' && nodes.length > 0 && (
            <Select aria-label={`Node to build ${build.dir || 'the repo root'} with`} value={choice.node ?? ''} onChange={(e) => pickNode(build, e.target.value)} className="h-8 text-dense" wrapClassName="max-w-md">
              <option value="">{build.node ?? 'The Node the panel picks'}</option>
              {nodes.map((v) => <option key={v} value={v}>{`Node ${v}`}</option>)}
            </Select>
          )}
          <span className="text-xs text-muted-foreground">
            in <code className="font-mono">{build.dir || '/'}</code> · {build.why}
            {choice.fromDocs && build.builtInRepo && `; ${docsFile} builds it${choice.script ? ` with ${choice.script}` : ''}, tick it to run it anyway`}
          </span>
          {choice.script && build.stopsOthers?.includes(choice.script) && (
            <span className="text-xs text-warning">{choice.script} runs its builds with concurrently --kill-others, so the first to finish stops the others: pick one of its parts, or change it to --kill-others-on-fail.</span>
          )}
        </div>
      </div>
    );
  };
  // A build the docs name stays in view even when it is off, with why.
  const needed = builds.filter((b) => {
    const choice = buildChoice(b, picks, commands);
    return choice.on || choice.fromDocs || b.needed;
  });
  const rest = builds.filter((b) => !needed.includes(b));
  return (
    <div className="grid gap-3">
      {title && <h3 className="font-mono text-xs font-medium text-muted-foreground">{title}</h3>}
      {needed.length > 0 ? <div className="grid gap-3">{needed.map(row)}</div> : <p className="text-xs text-muted-foreground">Nothing needs a build.</p>}
      {rest.length > 0 && (
        <details className="rounded-lg border bg-card px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">Ships its built files ({rest.length})</summary>
          <div className="mt-3 grid gap-3">{rest.map(row)}</div>
        </details>
      )}
    </div>
  );
}

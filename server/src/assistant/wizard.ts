import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { RepoPreset, Site, UploadResult, WizardSuggestion } from '@devmagic-panel/shared';
import { branchName, coreVersion, hostname, isLocalName, repoKey, repoPreset, wpSlug } from '@devmagic-panel/shared';
import { z } from 'zod';
import type { Executor } from '../exec.js';
import { inspectRepo } from '../sites/repo.js';
import { readUpload } from '../sites/uploads.js';
import type { ClaudeFactory } from './briefing.js';
import { redact } from './redact.js';

export class WizardRefused extends Error {}

export interface WizardInput {
  description: string;
  repoUrl?: string | undefined;
  branch?: string | undefined;
  uploadId?: string | undefined;
}

export interface WizardDeps {
  exec: Executor;
  workDir: string;
  uploadsDir: string;
  sites: () => Promise<Site[]>;
  cores: () => string[];
  conventions: () => string;
  /** The wizard's answers from the last install of a repo, by repoKey. */
  preset: (repo: string) => unknown;
}

/** Plain strings in the output schema; every value is checked against the registry's own rules afterwards. */
const Output = z.object({
  domains: z.array(z.object({ production: z.string().optional(), local: z.string() })),
  layout: z.enum(['site-root', 'wp-content', 'theme', 'plugin']),
  branch: z.string(),
  core: z.object({ mode: z.enum(['wpcore', 'standalone']), version: z.string() }).optional(),
  deactivate: z.array(z.string()),
  uploadsFrom: z.string().optional(),
  build: z.object({ composer: z.boolean(), npm: z.boolean() }),
  notes: z.string(),
});

const SYSTEM = `You fill in the new site wizard of devmagic-panel, which installs WordPress sites locally on a developer's machine.
You get the developer's description, this machine's conventions, the repo's docs and the wizard's answers from its last install here when there are any, facts from the database dump when one was uploaded, the sites already on this machine and the installed WordPress cores.
Decide the local domains (the first is the primary domain; pair each production host from the dump with its local name), what the repo holds, the branch, the WordPress core (only an installed version), plugins to deactivate after the import, where missing uploads load from and the build.
Follow the repo's docs and the last install's answers first, then the conventions, then what similar existing sites do. In notes, say in one or two plain sentences what you assumed or could not decide. Write without em dashes.`;

const compact = (s: Site) => ({ domain: s.domain, aliases: s.aliases.length, core: s.core, multisite: s.network?.mode, remote: s.git?.remote, ...(s.repos?.length ? { innerRepos: s.repos.map((r) => ({ folder: r.folder, remote: r.git.remote })) } : {}), database: s.db?.name });

/** Turns Claude's answer into a repo preset, dropping anything the panel would refuse. */
export function toPreset(out: z.infer<typeof Output>, cores: string[]): RepoPreset {
  const domains = out.domains.flatMap((d) => {
    const local = d.local.trim().toLowerCase();
    if (!isLocalName(local)) return [];
    const production = d.production?.trim().toLowerCase();
    return [{ local, ...(production && hostname.safeParse(production).success ? { production } : {}) }];
  });
  if (domains.length === 0) throw new WizardRefused('Claude did not suggest a usable local domain; fill the wizard by hand');
  const core = out.core && coreVersion.safeParse(out.core.version).success && cores.includes(out.core.version) ? out.core : undefined;
  return repoPreset.parse({
    domains: domains.filter((d, i) => domains.findIndex((x) => x.local === d.local) === i),
    layout: out.layout,
    ...(core ? { core } : {}),
    deactivate: out.deactivate.filter((p) => wpSlug.safeParse(p).success),
    ...(out.uploadsFrom && hostname.safeParse(out.uploadsFrom).success ? { uploadsFrom: out.uploadsFrom } : {}),
    build: out.build,
  });
}

/**
 * Asks Claude to fill in the wizard from a plain description, the repo, the
 * dump and this machine's conventions. Nothing is installed: the wizard shows
 * the result for review, and Install runs it as by hand.
 */
export async function suggestWizard(claude: ClaudeFactory, apiKey: string | undefined, model: string, deps: WizardDeps, input: WizardInput): Promise<WizardSuggestion> {
  const repo = input.repoUrl ? await inspectRepo(deps.exec, deps.workDir, input.repoUrl, input.branch, ['README.md', 'CLAUDE.md']).catch((error: Error) => ({ error: error.message })) : undefined;
  const upload = input.uploadId ? readUpload(deps.uploadsDir, input.uploadId) : null;
  const dump: Partial<UploadResult> | undefined = upload ? { name: upload.name, facts: upload.facts } : undefined;
  const cores = deps.cores();
  const key = input.repoUrl ? repoKey(input.repoUrl) : null;
  const last = key ? repoPreset.safeParse(deps.preset(key)) : null;
  const sent = redact(
    JSON.stringify(
      {
        description: input.description,
        conventions: deps.conventions(),
        repo: input.repoUrl ? { url: input.repoUrl, requestedBranch: input.branch, ...repo, lastInstallHere: last?.success ? last.data : 'none' } : 'none given',
        dump: dump ?? 'none uploaded yet',
        existingSites: (await deps.sites()).map(compact),
        installedCores: cores,
      },
      null,
      1,
    ),
  );
  const response = await claude(apiKey).messages.parse({
    model,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: sent }],
    output_config: { format: zodOutputFormat(Output) },
  });
  const out = response.parsed_output;
  if (response.stop_reason === 'refusal' || !out) throw new WizardRefused('Claude did not fill in the wizard this time; fill it by hand');
  const fallback = repo && 'branch' in repo ? repo.branch : 'master';
  const branch = branchName.safeParse(out.branch).success ? out.branch : fallback;
  return { preset: toPreset(out, cores), branch, notes: out.notes, sent };
}

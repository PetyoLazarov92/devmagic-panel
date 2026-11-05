import type { z } from 'zod';
import type { ActionInput } from './actions.js';
import type { repoPreset } from './actions.js';

export type RepoPreset = z.infer<typeof repoPreset>;

/** What a repo URL tells before cloning: its branches, and what the wizard remembers about it. */
export interface RepoInspection {
  defaultBranch?: string;
  /** The branch to clone: the one asked for, otherwise the default. */
  branch: string;
  /** Every branch on the remote, the default first, then by name. */
  branches?: string[];
  /** The wizard's answers from the last install of this repo on this machine. */
  preset?: RepoPreset;
}

/** The wizard's answers for a site installed from a repo, remembered for the next install of the same repo. */
export function presetFromCreate(input: ActionInput<'site.create'>): RepoPreset | null {
  if (!input.repo) return null;
  const locals = [input.domain, ...input.aliases];
  return {
    domains: locals.map((local) => {
      const production = input.replace.find((r) => r.to === local)?.from;
      return { ...(production ? { production } : {}), local };
    }),
    layout: input.repo.layout,
    ...(input.core ? { core: input.core } : {}),
    deactivate: input.deactivate,
    activate: input.activate,
    ...(input.uploadsFrom ? { uploadsFrom: input.uploadsFrom, uploadsVia: input.uploadsVia } : {}),
    build: input.build,
    ...(input.network ? { network: input.network } : {}),
  };
}

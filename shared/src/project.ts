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

/** The wizard's answers for a site installed from a project, remembered for the next install of its main repo. */
export function presetFromCreate(input: ActionInput<'site.create'>): RepoPreset | null {
  const [main, ...others] = input.repos;
  if (!main) return null;
  const locals = [input.domain, ...input.aliases];
  return {
    domains: locals.map((local) => {
      const production = input.replace.find((r) => r.to === local)?.from;
      return { ...(production ? { production } : {}), local };
    }),
    placement: { dir: main.dir, folder: main.folder },
    extra: others.map((r) => ({ url: r.url, branch: r.branch, dir: r.dir, folder: r.folder })),
    ...(input.core ? { core: input.core } : {}),
    deactivate: input.deactivate,
    activate: input.activate,
    ...(input.uploadsFrom ? { uploadsFrom: input.uploadsFrom, uploadsVia: input.uploadsVia } : {}),
    ...(input.builds ? { builds: input.builds } : { build: input.build }),
    ...(input.network ? { network: input.network } : {}),
  };
}

/** Whether a repo may run here, and whose it is: see server/src/repo-trust.ts. */
export interface RepoTrustAnswer {
  owner: { host: string; owner: string } | null;
  trusted: boolean;
  why?: 'namespace' | 'trusted' | 'listed';
}

/** An rclone remote, by name and type (drive, dropbox, onedrive, s3, sftp, webdav...). */
export interface RcloneRemotes {
  installed: boolean;
  remotes: Array<{ name: string; type: string }>;
}

/** A folder or a dump in an rclone remote. */
export interface RemoteEntry {
  name: string;
  path: string;
  dir: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

/** A repo's remembered answers, as Settings lists them. */
export interface RememberedRepo {
  /** The repo as the panel keys it: its web address in lower case. */
  key: string;
  /** Its host and path for the list: github.com/wandworks/site. */
  name: string;
  updatedAt: string;
  /** null when the stored answers no longer read (Forget clears them). */
  preset: RepoPreset | null;
}


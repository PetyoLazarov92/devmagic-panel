import type { ServerFiles, RepoTrustAnswer, WporgPlugin, NewSiteSource, SiteServer, RepoPlacement, UploadResult } from '@devmagic-panel/shared';
import { type LocalHelperPlugin } from '@devmagic-panel/shared';
import { type OrgState } from './org';
import { type DumpSource } from './database';
import { type BuildPick } from '@/lib/builds';
import { type WizardStep } from '@/lib/drafts';
import { type NetworkAnswers } from '@/lib/network';
import { type RepoHelpers, type RepoRow } from '@/lib/project-repos';
import { type PluginPick, type ThemePick } from '@/lib/missing-plugins';

export type Step = WizardStep;

export interface DomainRow {
  prod: string;
  local: string;
}

export interface WizardState {
  source: NewSiteSource;
  repoUrl: string;
  /** Empty until the repo is read; then its default branch, or the one you pick. */
  branch: string;
  /** The repo's branches, default first; null until read, or when the lookup failed (the branch is typed then). */
  branches: string[] | null;
  defaultBranch?: string;
  /** Where the repo goes in the site; null until you or a last install chose: then by what the repo holds. */
  placement: RepoPlacement | null;
  upload: UploadResult | null;
  domains: DomainRow[];
  /** repo: the repo holds WordPress core, used as it is. */
  coreMode: 'wpcore' | 'standalone' | 'repo';
  coreVersion: string;
  /** null until you type one: admin, or superadmin for a network. */
  adminUser: string | null;
  /** null until you type one: the same as the user name. Never saved; only sent with the install. */
  adminPassword: string | null;
  /** null until you type one: admin@ the primary local domain. */
  adminEmail: string | null;
  /** For a dump that has the user already: leave it, or give it this password and the admin role. */
  adminIfExists: 'keep' | 'update';
  /** For a dump without the user: create it, or add none. */
  adminIfMissing: 'create' | 'skip';
  /** For a dump whose admins the scan read: make an admin for this copy; null until you choose (on when it has none). */
  adminCreate: boolean | null;
  deactivate: string[];
  activate: LocalHelperPlugin[];
  /** The local helpers the repo's branch has, and whether it has BE Media from Production, read in the background for repo URL and branch `key`. */
  helpers: RepoHelpers | null;
  /** Your ticks and scripts in the build checklist, by row (lib/builds); unset rows follow the lookup and the docs. */
  buildPicks: Record<string, BuildPick>;
  /** Where missing images load from; null until set: the first step 2 address that is not a local name. Empty: none. */
  uploadsFrom: string | null;
  /** How they load; null until chosen: BE Media from Production when the repo has it, else a redirect. */
  uploadsVia: 'redirect' | 'plugin' | null;
  /** Search and replace the production domains after the import. */
  replaceOn: boolean;
  /** For a network in the dump: its layout here and the addresses you typed for its sites. */
  network: NetworkAnswers;
  composer: boolean;
  npm: boolean;
  /** What the panel remembers about the repo, read when the URL is pasted. */
  inspection: Inspection;
  /** Install under a path of an existing site, like /learn on local.spellbook.example; null for a site of its own. */
  under: { domain: string; path: string } | null;
  /** The primary domain is installed already: archive that site first and install again. */
  replaceExisting: boolean;
  /** Apache or nginx, once nginx runs next to Apache; null until it is known: the default for new sites from the nginx tab. */
  server: SiteServer | null;
  /** Installing from a GitHub organization or GitLab group: the repo, what Claude Code read and the dump; null for the other starts. */
  org: OrgState | null;
  /** Remember the answers for the next install of this repo. */
  remember: boolean;
  /** The other repos of the site, each with its branch and folder; the main one is repoUrl and the fields around it. */
  extra: RepoRow[];
  /** Whether each picked repo may run here, by URL, as the server answered. */
  trust: Record<string, RepoTrustAnswer>;
  /** Where the dump comes from on the Database step. */
  dumpSource?: DumpSource;
  /** No dump: a fresh WordPress on the repo's code. */
  noDump: boolean;
  /** Clean the copy after the import: one user kept, orders, entries, logs and keys removed. Off unless you choose it. */
  cleanCopy?: boolean;
  /** Where the main repo shows among the picked ones on the Code step; first when unset. Make main moves the role, not the rows. */
  mainAt?: number;
  /** What you chose for each plugin the dump has that no repo brings, by its file; unset ones follow defaultPick. */
  pluginPicks: Record<string, PluginPick>;
  /** WordPress.org's answer for each missing plugin's slug: its name and latest version, or null when it does not have it. */
  wporg: Record<string, WporgPlugin | null>;
  /** The plugins the last install of the repo installed from WordPress.org, ticked again. */
  rememberedPlugins: string[];
  /** What you chose for each theme the dump uses that no repo brings, by its folder. */
  themePicks?: Record<string, ThemePick>;
  /** WordPress.org's answer for each missing theme. */
  wporgThemes?: Record<string, WporgPlugin | null>;
  /** The server the dump was exported from and its WordPress folder: what the dump names and nothing else has can be copied from there. No secret. */
  serverFrom?: { host: string; folder: string; wpCli?: string } | null;
  /** Also copy the uploads from that server after the import. Off unless you tick it. */
  copyUploads?: boolean;
  /** With that on: only the last months; all of them when unset. */
  uploadsMonths?: number | null;
  /** That server's password, when it asks for one: held for this visit only, sent with the install, never in a draft. */
  serverSecret?: string | null;
  /** The plugins and themes that server has, once read. */
  serverHas?: ServerFiles | null;
  /** A hash of each step's answers when you continued from it, so the step list can open the steps you reached (lib/steps). */
  passed: Partial<Record<Step, string>>;
}

export type Inspection =
  | { status: 'idle' | 'reading' | 'none'; url?: string }
  | { status: 'found'; url: string; branch: string; summary: string }
  | { status: 'claude'; url: string; branch: string; summary: string; notes: string }
  | { status: 'error'; url: string; message: string };

export type Setter = <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;

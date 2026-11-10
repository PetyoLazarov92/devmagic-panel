import type { ActionId } from './actions.js';
import type { RepoPreset } from './project.js';
import type { AuraItem } from './sites.js';

/** Models offered for the assistant; the first is the default. */
export const ASSISTANT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best answers)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
] as const;

export type AssistantModel = (typeof ASSISTANT_MODELS)[number]['id'];

export const isAssistantModel = (id: string): id is AssistantModel => ASSISTANT_MODELS.some((m) => m.id === id);

/** The assistant's settings as the browser sees them; the key itself never leaves the server. */
export interface AssistantSettings {
  enabled: boolean;
  model: AssistantModel;
  /**
   * panel: a key saved in the panel's secrets file; environment: ANTHROPIC_API_KEY
   * or ANTHROPIC_AUTH_TOKEN in the server's environment; none: neither, so an
   * `ant auth login` profile is used if there is one.
   */
  keySource: 'panel' | 'environment' | 'none';
  /** The last four characters of a saved key, to tell keys apart. */
  keyHint?: string;
}

/** The login briefing: Claude's summary of the Aura findings, each point tied to real items and their fixes. */
export type Briefing =
  | { status: 'off' }
  | { status: 'clear'; sent: string }
  | { status: 'error'; error: string }
  | {
      status: 'ready';
      headline: string;
      points: Array<{ text: string; items: AuraItem[] }>;
      model: string;
      generatedAt: string;
      /** Exactly what was sent to Claude, so you can check it. */
      sent: string;
    };

/** One message of the chat as the browser keeps it; tool calls stay on the server. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A change Claude suggests. Nothing runs until you click Run on its card,
 * which goes through the same action route as the panel's own buttons.
 */
export interface Proposal {
  id: string;
  action: ActionId;
  title: string;
  description: string;
  input: Record<string, unknown>;
  /** Claude's one-line reason. */
  why?: string;
}

/** A proposal queued from an MCP client like Claude Code, waiting in the panel for your click. */
export interface QueuedProposal extends Proposal {
  /** The client that suggested it, like claude-code. */
  source: string;
  createdAt: string;
}

export interface ChatReply {
  reply: string;
  proposals: Proposal[];
  /** The read tools Claude used this turn, like `read_log local.shop.com`. */
  looked: string[];
}

/**
 * Actions Claude may not propose: they delete data or need your own typed
 * confirmation or upload, so they stay on their own pages.
 */
export const ASSISTANT_EXCLUDED_ACTIONS: readonly ActionId[] = ['site.remove', 'site.create', 'org.readRepo', 'org.checkAccess', 'dump.download', 'dump.useDownloaded', 'dump.fromRemote', 'dump.fetch', 'dump.fromServer', 'dump.fromLocal', 'site.copyFromServer', 'site.copyUploads', 'site.takeOver', 'site.giveBack', 'db.restore', 'db.import', 'db.deleteSnapshot', 'core.remove', 'trash.delete', 'panel.update', 'panel.switchRelease', 'panel.installRelease', 'history.clear', 'cron.undo', 'cron.clearRuns', 'wpcron.undo', 'mysql.updateRow', 'mysql.insertRow', 'mysql.deleteRows', 'mysql.undoRowChange', 'db.cleanContent', 'db.cleanOrphans', 'mysql.emptyTable', 'mysql.dropTable', 'mysql.undoCleanup', 'mysql.runSql', 'mysql.killQuery', 'mysql.importDump'];

/** Claude's settings for the new site wizard, shaped like a repo preset so the wizard fills itself the same way. */
export interface WizardSuggestion {
  preset: RepoPreset;
  /** The branch to clone. */
  branch: string;
  /** What Claude assumed or could not decide, in a sentence or two. */
  notes: string;
  /** Exactly what was sent to Claude. */
  sent: string;
}

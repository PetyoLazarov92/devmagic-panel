import { existsSync, readFileSync } from 'node:fs';
import type { AssistantSettings, AuraReport, Briefing, ChatReply, WizardSuggestion } from '@devmagic-panel/shared';
import { ASSISTANT_MODELS, branchName, gitUrl } from '@devmagic-panel/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeSecrets, type Secrets } from '../secrets.js';
import { Briefings, describeError, type ClaudeFactory } from './briefing.js';
import { chat, type ChatDeps } from './chat.js';
import { MAX_CONVENTIONS, writeConventions } from './conventions.js';
import { suggestWizard, WizardRefused, type WizardDeps } from './wizard.js';
import { readSettings, writeSettings } from './settings.js';

export interface AssistantDeps {
  secrets: () => Secrets | null;
  secretsFile: string;
  settingsFile: string;
  claude: ClaudeFactory;
  /** The current Aura findings, from the site routes' cache. */
  aura: () => Promise<AuraReport>;
  /** What the chat's read tools read from. */
  chat: ChatDeps;
  /** What the wizard helper reads from. */
  wizard: WizardDeps;
  /** Your conventions.md, next to settings.json. */
  conventionsFile: string;
  defaultConventions: () => string;
  env?: Record<string, string | undefined>;
}

const SettingsInput = z.object({
  enabled: z.boolean().optional(),
  model: z.enum(ASSISTANT_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
});
const ChatInput = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000) }))
    .min(1)
    .max(40)
    .refine((m) => m[0]?.role === 'user' && m.at(-1)?.role === 'user', 'The chat starts and ends with your message'),
});
const WizardBody = z.object({
  description: z.string().min(3).max(4000),
  repoUrl: gitUrl.optional(),
  branch: branchName.optional(),
  uploadId: z.string().regex(/^[0-9a-f-]{36}$/).optional(),
});
const ConventionsBody = z.object({ text: z.string().max(MAX_CONVENTIONS) });
const KeyInput = z.object({ apiKey: z.string().regex(/^sk-ant-[A-Za-z0-9_-]{20,300}$/, 'An Anthropic API key starts with sk-ant-') });

/**
 * The assistant's own settings. These are deliberately not registry actions:
 * the assistant's tools come from the registry, and it must never be able to
 * change its own key or switch itself on.
 */
export function registerAssistantRoutes(api: FastifyInstance, deps: AssistantDeps): void {
  const env = deps.env ?? process.env;
  const briefings = new Briefings(deps.claude);
  const savedKey = () => deps.secrets()?.anthropic?.apiKey;

  const view = (): AssistantSettings => {
    const { assistant } = readSettings(deps.settingsFile);
    const key = savedKey();
    const keySource = key ? 'panel' : env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? 'environment' : 'none';
    return { ...assistant, keySource, ...(key ? { keyHint: key.slice(-4) } : {}) };
  };

  api.get('/api/assistant', async () => view());

  api.put<{ Body: unknown }>('/api/assistant', async (request, reply) => {
    const parsed = SettingsInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid settings' });
    const current = readSettings(deps.settingsFile);
    writeSettings(deps.settingsFile, { assistant: { ...current.assistant, ...(parsed.data as Partial<typeof current.assistant>) } });
    return view();
  });

  api.put<{ Body: unknown }>('/api/assistant/key', async (request, reply) => {
    const parsed = KeyInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid key' });
    const current = deps.secrets();
    if (!current) return reply.code(409).send({ error: 'Run the panel setup first' });
    writeSecrets(deps.secretsFile, { ...current, anthropic: { apiKey: parsed.data.apiKey } });
    return view();
  });

  api.delete('/api/assistant/key', async () => {
    const current = deps.secrets();
    if (current?.anthropic) {
      const { anthropic: _removed, ...rest } = current;
      writeSecrets(deps.secretsFile, rest);
    }
    return view();
  });

  // Checks the key and model with a token count, which costs nothing.
  api.post('/api/assistant/test', async () => {
    const { assistant } = readSettings(deps.settingsFile);
    try {
      await deps.claude(savedKey()).messages.countTokens({ model: assistant.model, messages: [{ role: 'user', content: 'ping' }] });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  // One chat turn. Read tools run; changes come back as proposal cards that run only when clicked.
  api.post<{ Body: unknown }>('/api/assistant/chat', async (request, reply): Promise<ChatReply | undefined> => {
    const { assistant } = readSettings(deps.settingsFile);
    if (!assistant.enabled) return reply.code(409).send({ error: 'Turn on the AI assistant on the Environment page first' });
    const parsed = ChatInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid chat' });
    try {
      return await chat(deps.claude(savedKey()), assistant.model, deps.chat, parsed.data.messages);
    } catch (error) {
      return reply.code(502).send({ error: describeError(error) });
    }
  });

  api.get('/api/assistant/conventions', async () => {
    const saved = existsSync(deps.conventionsFile);
    return { text: saved ? readFileSync(deps.conventionsFile, 'utf8') : deps.defaultConventions(), saved, path: deps.conventionsFile };
  });

  api.put<{ Body: unknown }>('/api/assistant/conventions', async (request, reply) => {
    const parsed = ConventionsBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid text' });
    writeConventions(deps.conventionsFile, parsed.data.text);
    return { text: readFileSync(deps.conventionsFile, 'utf8'), saved: true, path: deps.conventionsFile };
  });

  // Fills in the new site wizard from a description; the wizard shows it for review and installs nothing by itself.
  api.post<{ Body: unknown }>('/api/assistant/wizard', async (request, reply): Promise<WizardSuggestion | undefined> => {
    const { assistant } = readSettings(deps.settingsFile);
    if (!assistant.enabled) return reply.code(409).send({ error: 'Turn on the AI assistant on the Environment page first' });
    const parsed = WizardBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    try {
      return await suggestWizard(deps.claude, savedKey(), assistant.model, deps.wizard, parsed.data);
    } catch (error) {
      if (error instanceof WizardRefused) return reply.code(422).send({ error: error.message });
      return reply.code(502).send({ error: describeError(error) });
    }
  });

  // Loaded by the Sites page after it shows, so it never slows down login.
  api.get('/api/assistant/briefing', async (): Promise<Briefing> => {
    const { assistant } = readSettings(deps.settingsFile);
    if (!assistant.enabled) return { status: 'off' };
    return briefings.brief(await deps.aura(), assistant.model, savedKey());
  });
}

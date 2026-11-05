import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ClaudeTokens, ClaudeUsage, OrgStatus } from '@devmagic-panel/shared';
import { z } from 'zod';
import type { Executor } from '../exec.js';
import { activityOf, jsonLines } from './activity.js';

/**
 * Claude Code, run headless (`claude -p`) with the user's own claude.ai sign-in
 * and connectors. The panel uses it only to read: a repo's docs copied into a
 * folder of their own, and the Asana tasks and Google files they link. Every
 * run has a fixed list of read-only tools, a spending cap, and an answer that
 * must fit a schema; the panel checks that answer again before using it.
 * `--setting-sources user` keeps the claude.ai connectors and leaves project
 * settings out.
 */

export const FILE_TOOLS = ['Read', 'Glob', 'Grep'];
export const ASANA_TOOLS = [
  'mcp__claude_ai_Asana__get_task',
  'mcp__claude_ai_Asana__get_tasks',
  'mcp__claude_ai_Asana__get_task_stories',
  'mcp__claude_ai_Asana__get_project',
  'mcp__claude_ai_Asana__get_attachments',
  'mcp__claude_ai_Asana__search_tasks',
  'mcp__claude_ai_Asana__search_objects',
];
/** Only metadata and search: never a file's contents, so a dump never passes through Claude. */
export const DRIVE_TOOLS = ['mcp__claude_ai_Google_Drive__get_file_metadata', 'mcp__claude_ai_Google_Drive__search_files'];
export const DOCS_TOOLS = ['mcp__claude_ai_Google_Docs__read_doc'];
/** Never allowed, whatever else is. */
export const DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'];

export class ClaudeCodeError extends Error {}

/** The claude command: on PATH, or where its installer puts it. */
export function findClaude(home: string, path = process.env.PATH ?? ''): string | null {
  const dirs = [...path.split(delimiter).filter(Boolean), join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/usr/local/bin'];
  for (const dir of dirs) {
    const bin = join(dir, 'claude');
    if (existsSync(bin)) return bin;
  }
  return null;
}

const authStatus = z.object({ loggedIn: z.boolean(), authMethod: z.string().optional() });

/**
 * Claude Code and its sign-in, which it keeps itself: the panel runs it as you
 * and never reads the saved token. Only a claude.ai sign-in brings the Asana
 * and Google connectors; anything but a clear yes counts as signed out.
 */
export async function claudeStatus(exec: Executor, home: string, path?: string): Promise<OrgStatus['claude']> {
  const bin = findClaude(home, path);
  if (!bin) return { found: false, signedIn: false, claudeAi: false };
  const version = await exec(bin, ['--version'], { timeoutMs: 15_000 });
  if (version.code !== 0) return { found: false, path: bin, signedIn: false, claudeAi: false };
  const auth = await exec(bin, ['auth', 'status', '--json'], { timeoutMs: 15_000 });
  let parsed: z.infer<typeof authStatus> | null = null;
  try {
    parsed = authStatus.parse(JSON.parse(auth.stdout));
  } catch {
    parsed = null;
  }
  const signedIn = parsed?.loggedIn === true;
  return { found: true, path: bin, version: version.stdout.trim().split(' ')[0] as string, signedIn, claudeAi: signedIn && parsed?.authMethod === 'claude.ai' };
}

export interface ClaudeRun<T> {
  bin: string;
  /** The folder it runs in; file tools see only this. */
  cwd: string;
  prompt: string;
  schema: z.ZodType<T>;
  tools: string[];
  model: string;
  /** How hard it thinks: low, medium or high. */
  effort: string;
  budgetUsd: number;
  timeoutMs?: number;
  /** Gets a line for each thing it does as it goes, like "Reading README.md" (activity.ts). */
  onActivity?: (line: string) => void;
}

const answer = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
});

/** The tokens of a run, when Claude Code reports them. */
function tokensOf(usage: z.infer<typeof answer>['usage']): ClaudeTokens | undefined {
  if (!usage) return undefined;
  return { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 };
}

/** The result event of Claude Code's stream; other events may come after it. */
function resultLine(stdout: string): unknown {
  const lines = stdout.split('\n').filter((l) => l.includes('"result"'));
  for (const line of lines.reverse()) {
    try {
      const event = JSON.parse(line) as { type?: unknown };
      if (event.type === 'result') return event;
    } catch {
      // not an event
    }
  }
  throw new Error('no result');
}

/** Runs Claude Code once and returns its answer, checked against the schema, with what it cost, how long it took and its tokens. */
export async function runClaude<T>(exec: Executor, run: ClaudeRun<T>, now: () => number = Date.now): Promise<{ output: T } & ClaudeUsage> {
  // Claude Code checks the schema itself and does not accept a $schema line.
  const { $schema: _draft, ...schema } = z.toJSONSchema(run.schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  const jsonSchema = JSON.stringify(schema);
  const started = now();
  const r = await exec(
    run.bin,
    [
      // The prompt goes on stdin: inlined docs can pass Linux's 128 KiB limit for one argument (spawn E2BIG).
      '-p',
      '--model', run.model,
      '--effort', run.effort,
      '--max-budget-usd', String(run.budgetUsd),
      '--setting-sources', 'user',
      // Its events as they happen, a JSON line each; the result line carries the answer.
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', jsonSchema,
      '--allowedTools', ...run.tools,
      '--disallowedTools', ...DENIED_TOOLS,
    ],
    {
      cwd: run.cwd,
      input: run.prompt,
      timeoutMs: run.timeoutMs ?? 5 * 60_000,
      // The stream repeats what the tools read, so it is bigger than the answer.
      maxBufferBytes: 32 * 1024 * 1024,
      ...(run.onActivity ? { onStdout: jsonLines((event) => activityOf(event, run.cwd).forEach((line) => run.onActivity?.(line))) } : {}),
    },
  );
  if (r.code === 127) throw new ClaudeCodeError('Claude Code is not installed');
  let parsed: z.infer<typeof answer>;
  try {
    parsed = answer.parse(resultLine(r.stdout));
  } catch {
    throw new ClaudeCodeError(`Claude Code gave no answer: ${(r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`}`);
  }
  if (parsed.subtype === 'error_max_budget_usd') throw new ClaudeCodeError(`Claude Code stopped at the spending cap of $${run.budgetUsd}; raise it in the organization settings`);
  if (parsed.is_error || r.code !== 0) throw new ClaudeCodeError(`Claude Code failed: ${(parsed.result ?? r.stderr).trim().split('\n')[0] || parsed.subtype || `exit ${r.code}`}`);
  const output = run.schema.safeParse(parsed.structured_output);
  if (!output.success) throw new ClaudeCodeError(`Claude Code's answer does not fit the form: ${output.error.issues[0]?.message ?? 'invalid'}`);
  const tokens = tokensOf(parsed.usage);
  return { output: output.data, costUsd: parsed.total_cost_usd ?? 0, durationMs: Math.max(0, now() - started), ...(tokens ? { tokens } : {}) };
}

/** The connector tools Claude Code sees, to show what an organization install can reach. */
export const connectorProbe = z.object({ tools: z.array(z.string().max(200)).max(400) });

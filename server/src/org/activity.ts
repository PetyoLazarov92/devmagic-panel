import { relative } from 'node:path';

/**
 * What Claude Code is doing, as short lines for the step that runs it: one
 * per tool call ("Reading README.md", "Asana: opening the task 1200001")
 * and the first line of what it says. Its events come from its own stream
 * (`--output-format stream-json`); the lines are text to show, never acted on.
 */

const MAX_LINE = 160;

/** What the connector tools do, by the end of their name. */
const TOOL_WORDS: Record<string, string> = {
  get_task: 'opening the task',
  get_tasks: 'listing tasks',
  get_task_stories: "reading the task's comments",
  get_project: 'opening the project',
  get_attachments: 'listing the attachments',
  search_tasks: 'searching tasks',
  search_objects: 'searching',
  get_file_metadata: 'reading the file details',
  search_files: 'searching files',
  read_doc: 'reading the document',
};

/** The input values that name what a tool looks at, in the order they are tried. */
const NAMING_KEYS = ['name', 'title', 'query', 'text', 'task_gid', 'task_id', 'project_gid', 'file_id', 'fileId', 'document_id', 'documentId', 'url'];

/** One line of plain text: no control characters, one space between words, cut to fit. */
export function cleanLine(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 3)}...` : flat;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A line for one tool call; cwd turns the files it reads into repo paths. */
export function toolLine(name: string, input: Record<string, unknown>, cwd: string): string {
  if (name === 'Read') {
    const file = str(input.file_path);
    return file ? `Reading ${file.startsWith('/') ? relative(cwd, file) || file : file}` : 'Reading a file';
  }
  if (name === 'Glob') return `Looking for files: ${str(input.pattern) ?? '*'}`;
  if (name === 'Grep') return `Searching the files for "${str(input.pattern) ?? ''}"`;
  if (name === 'StructuredOutput') return 'Writing the answer';
  const mcp = /^mcp__(?:claude_ai_)?([A-Za-z0-9]+(?:_[A-Z][A-Za-z0-9]*)*)__(.+)$/.exec(name);
  if (mcp) {
    const service = (mcp[1] as string).replaceAll('_', ' ');
    const tool = mcp[2] as string;
    const what = TOOL_WORDS[tool] ?? tool.replaceAll('_', ' ');
    const naming = NAMING_KEYS.map((k) => str(input[k])).find(Boolean);
    return `${service}: ${what}${naming ? ` ${naming}` : ''}`;
  }
  return `Using ${name}`;
}

/** The lines one event of Claude Code's stream gives: its tool calls and the first line of its text. */
export function activityOf(event: unknown, cwd: string): string[] {
  if (!event || typeof event !== 'object') return [];
  const e = event as { type?: unknown; message?: { content?: unknown } };
  if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) return [];
  const lines: string[] = [];
  for (const block of e.message.content as Array<Record<string, unknown>>) {
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      lines.push(cleanLine(toolLine(block.name, (block.input as Record<string, unknown>) ?? {}, cwd)));
    } else if (block.type === 'text' && typeof block.text === 'string') {
      const first = block.text.split('\n').find((l) => l.trim());
      if (first) lines.push(cleanLine(first));
    }
  }
  return lines.filter(Boolean);
}

/**
 * Splits a stream into its JSON lines as chunks arrive: a line cut between
 * two chunks waits for the rest; one that is not JSON is skipped.
 */
export function jsonLines(onEvent: (event: unknown) => void): (chunk: string) => void {
  let rest = '';
  return (chunk) => {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    for (const part of parts) {
      if (!part.trim()) continue;
      try {
        onEvent(JSON.parse(part));
      } catch {
        // not an event
      }
    }
  };
}

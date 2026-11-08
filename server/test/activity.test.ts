import { describe, expect, it } from 'vitest';
import { activityOf, cleanLine, jsonLines, toolLine } from '../src/org/activity.js';

describe("Claude Code's activity", () => {
  it('names each tool call in a short line, files as repo paths', () => {
    expect(toolLine('Read', { file_path: '/work/docs/README.md' }, '/work/docs')).toBe('Reading README.md');
    expect(toolLine('Glob', { pattern: 'docs/**/*.md' }, '/work')).toBe('Looking for files: docs/**/*.md');
    expect(toolLine('Grep', { pattern: 'dump' }, '/work')).toBe('Searching the files for "dump"');
    expect(toolLine('mcp__claude_ai_Asana__get_task', { task_gid: '1200001' }, '/w')).toBe('Asana: opening the task 1200001');
    expect(toolLine('mcp__claude_ai_Google_Drive__search_files', { query: 'wandworks-store' }, '/w')).toBe('Google Drive: searching files wandworks-store');
    expect(toolLine('mcp__claude_ai_Google_Docs__read_doc', {}, '/w')).toBe('Google Docs: reading the document');
    expect(toolLine('StructuredOutput', {}, '/w')).toBe('Writing the answer');
    expect(toolLine('Mystery', {}, '/w')).toBe('Using Mystery');
  });

  it('keeps one plain line, without control characters, cut to fit', () => {
    expect(cleanLine('a\u001b[31m red\n\tline  ')).toBe('a [31m red line');
    expect(cleanLine('x'.repeat(300))).toHaveLength(160);
  });

  it('reads only what Claude does and says, not what tools return', () => {
    expect(activityOf({ type: 'user', message: { content: [{ type: 'tool_result', content: 'secret file text' }] } }, '/w')).toEqual([]);
    expect(activityOf({ type: 'assistant', message: { content: [{ type: 'text', text: '\n\nFirst line\nsecond' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.md' } }] } }, '/w')).toEqual(['First line', 'Reading a.md']);
    expect(activityOf('nonsense', '/w')).toEqual([]);
  });

  it('splits the stream into events however its chunks are cut', () => {
    const seen: unknown[] = [];
    const feed = jsonLines((e) => seen.push(e));
    feed('{"type":"a"}\n{"ty');
    feed('pe":"b"}\nnot json\n');
    feed('{"type":"c"}');
    expect(seen).toEqual([{ type: 'a' }, { type: 'b' }]);
    feed('\n');
    expect(seen).toEqual([{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
  });
});

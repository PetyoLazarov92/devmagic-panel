import { BrowseError } from './mysql-sql.js';

/**
 * Explain for a statement that writes, kept read only: MySQL wants the right
 * to run an UPDATE or DELETE before it explains one, and the SQL runner's
 * account has none. What makes such a statement slow is finding its rows,
 * so the runner explains the SELECT that finds the same rows instead (the
 * plan MySQL picks for both is the same): an UPDATE's or a DELETE's tables
 * and WHERE, the SELECT of an INSERT ... SELECT. That SELECT then goes
 * through every lock a SELECT of yours does.
 */

interface Word {
  word: string;
  start: number;
  end: number;
}

/** The words outside strings, names in backticks, comments and parentheses, upper case with where they are. */
export function topWords(text: string): Word[] {
  const out: Word[] = [];
  let depth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < n && text[i] !== c) i += text[i] === '\\' && c !== '`' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '#' || (c === '-' && text[i + 1] === '-' && /\s|$/.test(text[i + 2] ?? ''))) {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z0-9_$]+/.exec(text.slice(i)) as RegExpExecArray;
      if (depth === 0) out.push({ word: m[0].toUpperCase(), start: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    i++;
  }
  return out;
}

/** The first word of these at the top level, from index `from` of the words. */
const find = (words: Word[], names: string[], from = 0) => words.slice(from).find((w) => names.includes(w.word));

/** Kinds of statement whose rows the runner explains by their SELECT. */
export const EXPLAINED_BY_SELECT = new Set(['UPDATE', 'DELETE', 'INSERT', 'REPLACE']);

/**
 * The SELECT that finds the rows a statement that writes would change, or
 * why it has none to explain. Throws BrowseError for a form it cannot read.
 */
export function readingPart(text: string, kind: string): { sql: string } | { none: string } {
  const words = topWords(text);
  if (kind === 'DELETE') {
    // DELETE FROM t1, t2 USING t1 JOIN t2 ... reads what follows USING; every other DELETE reads from its FROM on.
    const from = find(words, ['FROM']);
    if (!from) throw new BrowseError('A DELETE without FROM: write it as DELETE FROM a_table WHERE ...');
    const using = find(words, ['USING'], words.indexOf(from));
    return { sql: using ? `SELECT * FROM ${text.slice(using.end).trim()}` : `SELECT * ${text.slice(from.start)}` };
  }
  if (kind === 'UPDATE') {
    const set = find(words, ['SET']);
    if (!set) throw new BrowseError('An UPDATE without SET: write it as UPDATE a_table SET a_column = 1 WHERE ...');
    const head = words.find((w) => w.word === 'UPDATE') as Word;
    let tablesFrom = head.end;
    for (const w of words.slice(words.indexOf(head) + 1)) {
      if (w.word !== 'LOW_PRIORITY' && w.word !== 'IGNORE') break;
      tablesFrom = w.end;
    }
    const rest = find(words, ['WHERE', 'ORDER', 'LIMIT'], words.indexOf(set));
    return { sql: `SELECT * FROM ${text.slice(tablesFrom, set.start).trim()}${rest ? ` ${text.slice(rest.start)}` : ''}` };
  }
  // INSERT and REPLACE: only a SELECT reads; VALUES and SET only write.
  const select = find(words, ['SELECT', 'WITH', 'TABLE', 'VALUES', 'VALUE', 'SET']);
  if (!select || select.word === 'VALUES' || select.word === 'VALUE' || select.word === 'SET') {
    return { none: `This ${kind} reads no table, it only writes the rows it lists: there is no plan to show. Its time goes to the indexes and triggers of the table it writes.` };
  }
  const index = words.indexOf(select);
  const duplicate = words.slice(index).find((w, k, after) => w.word === 'ON' && after[k + 1]?.word === 'DUPLICATE');
  return { sql: text.slice(select.start, duplicate ? duplicate.start : undefined).trim() };
}

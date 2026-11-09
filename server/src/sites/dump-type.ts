import { closeSync, openSync, readSync } from 'node:fs';

/** What a dump file is, by its first bytes: never by its name or a server's Content-Type. */
export type DumpType = 'sql' | 'gzip' | 'zip';

/** The bytes a type check reads. */
export const SNIFF_BYTES = 4096;

/** How a plain SQL dump starts, after a BOM and blank lines: a comment, a statement or MySQL's version comment. */
const SQL_START = /^(?:--|#|\/\*|SET\b|CREATE\b|DROP\b|INSERT\b|LOCK\b|USE\b|START\b|BEGIN\b|DELIMITER\b|ALTER\b|REPLACE\b)/i;

/** The type of a dump from its first bytes, or null for anything else (a web page, an image, a program). */
export function sniffDump(head: Uint8Array): DumpType | null {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  if (head.length === 0 || head.includes(0)) return null;
  const text = Buffer.from(head).toString('utf8').replace(/^﻿/, '').trimStart();
  return SQL_START.test(text) ? 'sql' : null;
}

/** The extension a dump of this type takes. */
export const DUMP_EXTENSION: Record<DumpType, string> = { sql: '.sql', gzip: '.sql.gz', zip: '.zip' };

/** The type a file name says: .sql, .sql.gz (or .gz) or .zip. */
export function typeByName(name: string): DumpType | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.gz')) return 'gzip';
  if (lower.endsWith('.sql')) return 'sql';
  return null;
}

/**
 * Checks that a file is the dump its name says, from its first bytes: a page
 * saved as dump.sql, or a zip renamed .sql.gz, is refused before anything
 * reads it. Throws with what it found.
 */
export function checkDumpFile(file: string, name = file): DumpType {
  const fd = openSync(file, 'r');
  const head = Buffer.alloc(SNIFF_BYTES);
  let read = 0;
  try {
    read = readSync(fd, head, 0, SNIFF_BYTES, 0);
  } finally {
    closeSync(fd);
  }
  const found = sniffDump(head.subarray(0, read));
  if (!found) throw new DumpTypeError(`${name.split('/').pop()} is not a database dump: it does not start like SQL, a gzip or a zip`);
  const named = typeByName(name);
  if (named && named !== found) throw new DumpTypeError(`${name.split('/').pop()} is named like ${DUMP_EXTENSION[named]} but holds ${found === 'sql' ? 'plain SQL' : `a ${found}`}: rename it or download it again`);
  return found;
}

export class DumpTypeError extends Error {}

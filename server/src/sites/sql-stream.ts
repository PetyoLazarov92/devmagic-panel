import { createReadStream, statSync } from 'node:fs';
import { PassThrough, pipeline, type Readable, Transform, type TransformCallback } from 'node:stream';
import { createGunzip } from 'node:zlib';

/**
 * A dump on its way into MySQL: read from disk, unpacked when it is a .gz,
 * without the lines only a managed host's server takes, with collations only
 * a newer MariaDB has translated, and wrapped in the session settings of the
 * import. Nothing is written to disk on the way.
 */

/**
 * Statements a dump from a managed host starts or ends with that fail here:
 * GTID_PURGED needs privileges and a replica's state, SQL_LOG_BIN needs
 * privileges. Matched only at the start of a line and dropped up to the
 * semicolon that ends a line (GTID_PURGED can run over several lines); rows
 * are never looked into.
 */
const DROPPED = [/^SET @@GLOBAL\.GTID_PURGED\b/i, /^SET @@SESSION\.SQL_LOG_BIN\b/i];
/** How much of a line's start is read to decide; every statement above fits. */
const HEAD_BYTES = 32;
const NEWLINE = 10;
const SEMICOLON = 59;

export class DropServerLines extends Transform {
  private mode: 'start' | 'keep' | 'drop' = 'start';
  private head = Buffer.alloc(0);
  /** While dropping: the last byte other than a space was a semicolon. */
  private ended = false;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.feed(chunk);
    done();
  }

  override _flush(done: TransformCallback): void {
    if (this.mode === 'start' && this.head.length > 0 && !this.dropped(this.head)) this.push(this.head);
    done();
  }

  private dropped(head: Buffer): boolean {
    const text = head.toString('latin1');
    return DROPPED.some((re) => re.test(text));
  }

  private feed(chunk: Buffer): void {
    let i = 0;
    while (i < chunk.length) {
      if (this.mode === 'keep') {
        // Most of a dump is long INSERT lines: passed on in whole slices up to the next newline.
        const nl = chunk.indexOf(NEWLINE, i);
        if (nl === -1) {
          this.push(chunk.subarray(i));
          return;
        }
        this.push(chunk.subarray(i, nl + 1));
        i = nl + 1;
        this.mode = 'start';
      } else if (this.mode === 'drop') {
        for (; i < chunk.length; i++) {
          const b = chunk[i] as number;
          if (b === NEWLINE && this.ended) {
            i++;
            this.mode = 'start';
            break;
          }
          if (b === SEMICOLON) this.ended = true;
          else if (b !== NEWLINE && b !== 13 && b !== 32 && b !== 9) this.ended = false;
        }
      } else {
        const nl = chunk.indexOf(NEWLINE, i);
        const end = Math.min(nl === -1 ? chunk.length : nl + 1, i + HEAD_BYTES - this.head.length);
        this.head = Buffer.concat([this.head, chunk.subarray(i, end)]);
        i = end;
        if (this.head.length < HEAD_BYTES && this.head.at(-1) !== NEWLINE) continue;
        const head = this.head;
        this.head = Buffer.alloc(0);
        this.mode = this.dropped(head) ? 'drop' : 'keep';
        this.ended = false;
        this.feed(head);
      }
    }
  }
}

/**
 * MariaDB 10.10 and later name their default collations after UCA 14.0.0
 * (utf8mb4_uca1400_ai_ci, utf8mb3_uca1400_ai_ci), which MySQL and older
 * MariaDB do not have: an import stops with "Unknown collation". They become
 * the 5.2.0 collation of the same character set (utf8mb4_unicode_520_ci),
 * the one WordPress itself asks for and every server has.
 */
const UCA1400 = /\b([a-z0-9]+)_uca1400_[a-z0-9_]+/gi;
const UCA1400_BYTES = Buffer.from('_uca1400_');
/** A line longer than this is rows, whatever it starts with. */
const MAX_STRUCTURE_LINE = 64 * 1024;
/** How much of a line's start tells rows from structure. */
const ROWS_HEAD = 16;
const ROWS = /^\s*(?:INSERT|REPLACE)\b/i;

/** The collations of one line of structure, translated; its bytes otherwise as they are. */
export const translateCollations = (line: Buffer): Buffer =>
  line.includes(UCA1400_BYTES) ? Buffer.from(line.toString('latin1').replace(UCA1400, '$1_unicode_520_ci'), 'latin1') : line;

/**
 * Translates those collations in the structure of a dump (CREATE TABLE and
 * SET lines), line by line. Rows are never looked into: a line that starts
 * with INSERT or REPLACE, or is too long to be structure, passes as it is,
 * so text in a post that names a collation stays as it was written.
 */
export class TranslateCollations extends Transform {
  private mode: 'line' | 'rows' = 'line';
  private line: Buffer = Buffer.alloc(0);

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    let i = 0;
    while (i < chunk.length) {
      const nl = chunk.indexOf(NEWLINE, i);
      if (this.mode === 'rows') {
        if (nl === -1) {
          this.push(chunk.subarray(i));
          break;
        }
        this.push(chunk.subarray(i, nl + 1));
        i = nl + 1;
        this.mode = 'line';
        continue;
      }
      const end = nl === -1 ? chunk.length : nl + 1;
      this.line = this.line.length ? Buffer.concat([this.line, chunk.subarray(i, end)]) : chunk.subarray(i, end);
      i = end;
      if (nl !== -1) {
        // A whole line: rows when it starts like them, structure otherwise.
        this.push(this.line.length > MAX_STRUCTURE_LINE || ROWS.test(this.line.subarray(0, ROWS_HEAD).toString('latin1')) ? this.line : translateCollations(this.line));
        this.line = Buffer.alloc(0);
      } else if (this.line.length >= ROWS_HEAD && (ROWS.test(this.line.subarray(0, ROWS_HEAD).toString('latin1')) || this.line.length > MAX_STRUCTURE_LINE)) {
        // Rows that go on past this chunk: passed on as they come, up to their newline.
        this.push(this.line);
        this.line = Buffer.alloc(0);
        this.mode = 'rows';
      }
    }
    done();
  }

  override _flush(done: TransformCallback): void {
    if (this.line.length) this.push(translateCollations(this.line));
    done();
  }
}

/** Sends before ahead of the stream and after at its end. */
export function wrapped(before: string, after: string): Transform {
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!started) {
        started = true;
        this.push(before);
      }
      done(null, chunk);
    },
    flush(done) {
      if (!started) this.push(before);
      done(null, after);
    },
  });
}

/**
 * The SQL modes WordPress cannot import under, as WP-CLI's db import drops
 * them (copied there from WordPress's wpdb).
 */
const INCOMPATIBLE_MODES = new Set(['NO_ZERO_DATE', 'ONLY_FULL_GROUP_BY', 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES', 'TRADITIONAL', 'ANSI']);

/** The statement that drops those modes from the session, or '' when none is set; the same one WP-CLI sends. */
export function sqlModeStatement(current: string): string {
  const modes = current
    .split(/[\r\n,]/)
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
  const kept = modes.filter((m) => !INCOMPATIBLE_MODES.has(m));
  return kept.length === modes.length ? '' : `SET SESSION sql_mode='${kept.join(',')}';`;
}

/**
 * What an import sends first and last: WP-CLI's own speedups for a file
 * import (it leaves them out when it reads stdin), and the binary log off for
 * this session when the account may. The newline before COMMIT keeps it off a
 * last comment line without one.
 */
export function importWrap(sqlMode: string, skipBinlog: boolean): { before: string; after: string } {
  const settings = [...(skipBinlog ? ['SET sql_log_bin = 0;'] : []), sqlMode, 'SET autocommit = 0;', 'SET unique_checks = 0;', 'SET foreign_key_checks = 0;'].filter(Boolean);
  return { before: `${settings.join(' ')}\n`, after: '\nCOMMIT;\n' };
}

/**
 * A .sql or .sql.gz file as the stream an import reads. onRead gets the bytes
 * read from the file on disk (the packed ones for a gzip) and its size. An
 * error anywhere, like a damaged gzip, comes out as an error of the stream.
 */
export function dumpStream(file: string, wrap: { before: string; after: string }, onRead?: (read: number, total: number) => void): Readable {
  const total = statSync(file).size;
  const source = createReadStream(file, { highWaterMark: 1024 * 1024 });
  let read = 0;
  source.on('data', (chunk) => {
    read += chunk.length;
    onRead?.(read, total);
  });
  const out = new PassThrough();
  const stages = [source, ...(file.endsWith('.gz') ? [createGunzip()] : []), new DropServerLines(), new TranslateCollations(), wrapped(wrap.before, wrap.after), out];
  pipeline(stages, (error) => {
    if (error) out.destroy(error);
  });
  return out;
}

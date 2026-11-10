import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/exec.js';
import { DropServerLines, dumpStream, importWrap, sqlModeStatement, TranslateCollations } from '../src/sites/sql-stream.js';

async function through(text: string, chunkSize = text.length || 1): Promise<string> {
  const chunks: Buffer[] = [];
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize));
  const out: Buffer[] = [];
  for await (const chunk of Readable.from(chunks).pipe(new DropServerLines())) out.push(chunk as Buffer);
  return Buffer.concat(out).toString();
}

async function readAll(stream: Readable): Promise<string> {
  const out: Buffer[] = [];
  for await (const chunk of stream) out.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(out).toString();
}

const MANAGED = [
  '-- MySQL dump 10.13',
  'SET @@SESSION.SQL_LOG_BIN= 0;',
  '',
  '--',
  '-- GTID state at the beginning of the backup',
  '--',
  '',
  "SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '3e11fa47-71ca-11e1-9e33-c80aa9429562:1-5,",
  "4f22ab58-82db-22f2-af44-d91bb0530673:1-9';",
  "INSERT INTO `wp_options` VALUES (1,'siteurl','https://wandworks.example','yes');",
  'SET @@SESSION.SQL_LOG_BIN = @MYSQLDUMP_TEMP_LOG_BIN;',
  '-- Dump completed',
].join('\n');

const KEPT = ['-- MySQL dump 10.13', '', '--', '-- GTID state at the beginning of the backup', '--', '', "INSERT INTO `wp_options` VALUES (1,'siteurl','https://wandworks.example','yes');", '-- Dump completed'].join('\n');

describe('a dump on its way into MySQL', () => {
  it("drops a managed host's GTID and binary log lines, the GTID list over several lines included, and keeps the rest", async () => {
    expect(await through(MANAGED)).toBe(KEPT);
  });

  it('gives the same result however the dump is cut into chunks', async () => {
    for (const size of [1, 2, 7, 31, 32, 33, 100]) expect(await through(MANAGED, size)).toBe(KEPT);
  });

  it('only looks at the start of a line, so the same words inside a row stay', async () => {
    const row = "INSERT INTO `wp_posts` VALUES (1,'SET @@GLOBAL.GTID_PURGED=1;');\n  SET @@SESSION.SQL_LOG_BIN= 0;\n";
    expect(await through(row)).toBe(row);
  });

  it('keeps long lines, Windows line ends and a last line without a newline whole', async () => {
    const long = `INSERT INTO \`wp_postmeta\` VALUES ${'(1,2,\'k\',\'v\'),'.repeat(5000)}(3,4,'k','v');`;
    const text = `${long}\r\nSET NAMES utf8mb4;\r\n-- end`;
    expect(await through(text, 4096)).toBe(text);
    expect(await through('SET @@SESSION.SQL_LOG_BIN= 0;')).toBe('');
  });

  it('drops the SQL modes WordPress cannot import under, as WP-CLI does, and says nothing when none is set', () => {
    expect(sqlModeStatement('ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION\n')).toBe(
      "SET SESSION sql_mode='NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';",
    );
    expect(sqlModeStatement('NO_ENGINE_SUBSTITUTION')).toBe('');
    expect(sqlModeStatement('STRICT_ALL_TABLES')).toBe("SET SESSION sql_mode='';");
  });

  it("wraps the import in WP-CLI's speedups, the binary log off first only when the account may", () => {
    expect(importWrap('', true)).toEqual({ before: 'SET sql_log_bin = 0; SET autocommit = 0; SET unique_checks = 0; SET foreign_key_checks = 0;\n', after: '\nCOMMIT;\n' });
    expect(importWrap("SET SESSION sql_mode='';", false).before).toBe("SET SESSION sql_mode=''; SET autocommit = 0; SET unique_checks = 0; SET foreign_key_checks = 0;\n");
  });

  it('unpacks a gzip on the way, counting the packed bytes read from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmp-stream-'));
    const file = join(dir, 'wandworks.sql.gz');
    writeFileSync(file, gzipSync(MANAGED));
    const seen: Array<[number, number]> = [];
    const text = await readAll(dumpStream(file, { before: 'BEFORE;\n', after: '\nAFTER;\n' }, (read, total) => seen.push([read, total])));
    expect(text).toBe(`BEFORE;\n${KEPT}\nAFTER;\n`);
    const size = gzipSync(MANAGED).length;
    expect(seen.at(-1)).toEqual([size, size]);
  });

  it('fails as a stream when the gzip is damaged, so the import cannot look finished', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmp-stream-'));
    const file = join(dir, 'wandworks.sql.gz');
    writeFileSync(file, gzipSync(randomBytes(100_000).toString('hex')).subarray(0, 20_000));
    await expect(readAll(dumpStream(file, { before: '', after: '' }))).rejects.toThrow();
  });
});

describe('a program fed a stream', () => {
  it('gets the whole stream on stdin', async () => {
    const r = await runCommand('wc', ['-c'], { inputStream: Readable.from([Buffer.alloc(300_000, 'a')]) });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('300000');
  });

  it('is stopped when the stream breaks, and says why', async () => {
    const input = new PassThrough();
    const running = runCommand('cat', [], { inputStream: input });
    input.write('INSERT INTO t VALUES (1);\n');
    input.destroy(new Error('unexpected end of file'));
    const r = await running;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('could not read the input: unexpected end of file');
  });

  it('is stopped when nothing is read for the stall time', async () => {
    const input = new PassThrough();
    input.write('SET autocommit = 0;\n');
    const r = await runCommand('cat', [], { inputStream: input, inputStallMs: 60_000 / 600 });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^stopped: nothing was read for/);
  });
});

describe('collations only a newer MariaDB has', () => {
  const through = async (chunks: Buffer[]) => {
    const out: Buffer[] = [];
    for await (const chunk of Readable.from(chunks).pipe(new TranslateCollations())) out.push(chunk as Buffer);
    return Buffer.concat(out).toString('latin1');
  };
  const DUMP = [
    '/*M!100616 SET NAMES utf8mb4 COLLATE utf8mb4_uca1400_ai_ci */;',
    'CREATE TABLE `wp_posts` (',
    '  `post_title` text COLLATE utf8mb4_uca1400_ai_ci NOT NULL,',
    '  `guid` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_uca1400_ai_ci NOT NULL',
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_as_cs;',
    "INSERT INTO `wp_posts` VALUES (1,'A post about utf8mb4_uca1400_ai_ci','https://www.spellbook.example/?p=1');",
    '  insert into `wp_posts` values (2,\'utf8mb3_uca1400_ai_ci\',\'x\');',
    "/*!50001 SET collation_connection      = utf8mb4_uca1400_ai_ci */;",
    '',
  ].join('\n');
  const WANT = DUMP
    .replace('COLLATE utf8mb4_uca1400_ai_ci */', 'COLLATE utf8mb4_unicode_520_ci */')
    .replace('text COLLATE utf8mb4_uca1400_ai_ci', 'text COLLATE utf8mb4_unicode_520_ci')
    .replace('COLLATE utf8mb3_uca1400_ai_ci NOT', 'COLLATE utf8mb3_unicode_520_ci NOT')
    .replace('COLLATE=utf8mb4_uca1400_as_cs', 'COLLATE=utf8mb4_unicode_520_ci')
    .replace('= utf8mb4_uca1400_ai_ci */', '= utf8mb4_unicode_520_ci */');

  it('become the 5.2.0 collation of their character set in the structure, and rows stay as they were written', async () => {
    expect(await through([Buffer.from(DUMP, 'latin1')])).toBe(WANT);
    expect(WANT).toContain("'A post about utf8mb4_uca1400_ai_ci'");
    expect(WANT).toContain("(2,'utf8mb3_uca1400_ai_ci'");
  });

  it('give the same answer however the dump is cut into chunks, a byte at a time included', async () => {
    const bytes = Buffer.from(DUMP, 'latin1');
    for (const size of [1, 2, 7, 16, 17, 64]) {
      const chunks: Buffer[] = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
      expect(await through(chunks)).toBe(WANT);
    }
  });

  it('pass a dump without them, bytes that are not text and a last line without a newline as they are', async () => {
    const plain = Buffer.concat([Buffer.from('CREATE TABLE `t` (x int) COLLATE=utf8mb4_unicode_520_ci;\nINSERT INTO `t` VALUES (', 'latin1'), Buffer.from([0, 255, 10, 13, 128]), Buffer.from(');\n-- end', 'latin1')]);
    expect(Buffer.from(await through([plain]), 'latin1').equals(plain)).toBe(true);
    expect(await through([Buffer.from('SET collation_connection = utf8mb4_uca1400_ai_ci', 'latin1')])).toBe('SET collation_connection = utf8mb4_unicode_520_ci');
    // A very long line is rows whatever it starts with: it is not held in memory to look into.
    const long = Buffer.from(`-- ${'x'.repeat(70 * 1024)} utf8mb4_uca1400_ai_ci\n`, 'latin1');
    expect(await through([long])).toBe(long.toString('latin1'));
  });
});

import { existsSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Room a dump needs in MySQL's data folder: tables and indexes take about twice the SQL, and a gzipped dump is about a sixth of it. */
export function importRoom(dumpFile: string): number {
  const size = statSync(dumpFile).size;
  const sql = /\.(gz|zip)$/.test(dumpFile) ? size * 6 : size;
  return sql * 2 + 1024 ** 3;
}

/** The free bytes on the disk that holds path, and which disk it is. */
/** The path itself, or the nearest folder above it that exists: what a disk check can ask about before a folder is made. */
export function existingFolder(path: string): string {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return p;
}

export function freeSpace(path: string): { dev: number; bytes: number } {
  const fs = statfsSync(path);
  return { dev: statSync(path).dev, bytes: fs.bavail * fs.bsize };
}

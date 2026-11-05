import { statfsSync, statSync } from 'node:fs';

/** Room a dump needs in MySQL's data folder: tables and indexes take about twice the SQL, and a gzipped dump is about a sixth of it. */
export function importRoom(dumpFile: string): number {
  const size = statSync(dumpFile).size;
  const sql = /\.(gz|zip)$/.test(dumpFile) ? size * 6 : size;
  return sql * 2 + 1024 ** 3;
}

/** The free bytes on the disk that holds path, and which disk it is. */
export function freeSpace(path: string): { dev: number; bytes: number } {
  const fs = statfsSync(path);
  return { dev: statSync(path).dev, bytes: fs.bavail * fs.bsize };
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every test run gets one temporary folder of its own (TMPDIR, which os.tmpdir() reads), and it is
 * removed when the run ends: the temporary trees the tests make never pile up in /tmp. Before this,
 * each run left its trees behind, and the pre-commit hook runs the tests on every commit.
 */
export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'dmp-vitest-'));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  return () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a folder a test left unreadable stays; the next run starts a fresh one anyway
    }
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  };
}

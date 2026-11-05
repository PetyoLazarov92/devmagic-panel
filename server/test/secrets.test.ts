import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubTokenNotice, removeGithubToken } from '../src/secrets.js';

describe('the GitHub token older panels saved', () => {
  it('is deleted from secrets.json once, keeping everything else, and noted for the Updates page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmp-secrets-'));
    const file = join(dir, 'secrets.json');
    const marker = join(dir, 'data', 'github-token-removed');
    writeFileSync(file, JSON.stringify({ panelPasswordHash: 'scrypt$a$b', anthropic: { apiKey: 'sk-ant-x' }, github: { token: 'github_pat_old' } }), { mode: 0o600 });

    expect(removeGithubToken(file, marker)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ panelPasswordHash: 'scrypt$a$b', anthropic: { apiKey: 'sk-ant-x' } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(githubTokenNotice(marker)).toContain('Revoke it on GitHub');

    // Nothing to do the next time, and no secrets file at all is fine too.
    expect(removeGithubToken(file, marker)).toBe(false);
    expect(removeGithubToken(join(dir, 'none.json'), marker)).toBe(false);
  });

  it('says so for 30 days only, and nothing when no token was ever deleted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmp-secrets-'));
    const marker = join(dir, 'github-token-removed');
    expect(githubTokenNotice(marker)).toBeUndefined();
    writeFileSync(marker, 'x');
    const old = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(marker, old, old);
    expect(githubTokenNotice(marker)).toBeUndefined();
    expect(existsSync(marker)).toBe(true);
  });
});

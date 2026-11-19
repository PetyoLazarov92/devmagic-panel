import { describe, expect, it } from 'vitest';
import { checkEnvironment } from '../src/environment.js';
import { majorsOf, parsePhpReleases, PHP_RELEASES_KEY, PHP_RELEASES_URL, PhpReleases, releaseDay, releasedFor, releasedNew } from '../src/php/releases.js';
import { fakeExec, tempTree, DMP } from './helpers.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** php.net's answer, trimmed to what the panel reads: newest first, one entry per release. */
const ANSWER = {
  '8.6.0': { announcement: true, tags: [], date: '19 Nov 2026' },
  '8.5.13': { announcement: true, tags: ['security'], date: '19 Nov 2026' },
  '8.4.28': { announcement: true, tags: ['security'], date: '19 Nov 2026' },
  '8.3.37': { announcement: true, tags: ['security'], date: '19 Nov 2026' },
  '8.5.12': { announcement: { English: '/releases/8_5_12.php' }, tags: ['security'], date: '21 Oct 2026' },
  '8.4.27': { announcement: { English: '/releases/8_4_27.php' }, tags: ['security'], date: '21 Oct 2026' },
};
const RELEASES = parsePhpReleases(ANSWER);
const SURY = (v: string) => `${v}-1+ubuntu24.04.1+deb.sury.org+1`;

function memory(prefs: Record<string, unknown> = {}) {
  const meta = new Map<string, string>([['preferences', JSON.stringify(prefs)]]);
  return { getMeta: (k: string) => meta.get(k), setMeta: (k: string, v: string) => void meta.set(k, v), meta };
}

describe("php.net's releases", () => {
  it('reads versions, days and security tags, and leaves anything else out', () => {
    expect(RELEASES).toContainEqual({ version: '8.4.28', date: '2026-11-19', security: true });
    expect(RELEASES).toContainEqual({ version: '8.6.0', date: '2026-11-19', security: false });
    expect(parsePhpReleases({ '8.4': { date: '19 Nov 2026' }, '8.4.1': { date: 'soon' }, 'x.y.z': {}, '8.4.2': null })).toEqual([]);
    expect(parsePhpReleases([])).toEqual([]);
    expect(parsePhpReleases('8.4.28')).toEqual([]);
    expect(releaseDay('3 Jan 2027')).toBe('2027-01-03');
    expect(releaseDay('2027-01-03')).toBeUndefined();
  });

  it('says a newer release apt lacks for builds of the PHP PPA, never for the system\'s own', () => {
    expect(releasedFor('8.4', RELEASES, SURY('8.4.27'), SURY('8.4.27'))).toEqual({ version: '8.4.28', date: '2026-11-19', security: true, inApt: false });
    expect(releasedFor('8.4', RELEASES, SURY('8.4.27'), SURY('8.4.28'))).toMatchObject({ version: '8.4.28', inApt: true });
    expect(releasedFor('8.4', RELEASES, SURY('8.4.28'), SURY('8.4.28'))).toBeUndefined();
    // Ubuntu's own 8.3.6 gets its fixes as new builds of 8.3.6: php.net's 8.3.37 does not apply.
    expect(releasedFor('8.3', RELEASES, '8.3.6-0ubuntu0.24.04.5', '8.3.6-0ubuntu0.24.04.5')).toBeUndefined();
    expect(releasedFor('8.4', RELEASES, undefined, undefined)).toBeUndefined();
  });

  it('names a new version final on php.net that apt does not offer yet', () => {
    expect(releasedNew(RELEASES, ['8.4', '8.5'], [])).toEqual([{ version: '8.6.0', date: '2026-11-19', security: false }]);
    expect(releasedNew(RELEASES, ['8.4', '8.5'], ['8.6'])).toEqual([]);
    expect(releasedNew(RELEASES, [], [])).toEqual([]);
    expect(majorsOf(['8.4', '9.0', '7.4'])).toEqual([8, 9]);
  });
});

describe('reading them', () => {
  const answering = (status = 200, body: unknown = ANSWER) => {
    const urls: string[] = [];
    return { urls, get: async (url: string) => (urls.push(url), { status, text: JSON.stringify(body) }) };
  };

  it('asks php.net for each major once, keeps the list, and asks again only when it is due', async () => {
    const store = memory();
    let now = Date.parse('2026-11-19T12:00:00Z');
    const php = answering();
    const releases = new PhpReleases(store, php.get, () => now);
    expect(await releases.refresh([8, 8])).toBe('read');
    expect(php.urls).toEqual([PHP_RELEASES_URL(8)]);
    expect(releases.kept()).toMatchObject({ at: '2026-11-19T12:00:00.000Z' });
    now += 2 * 3_600_000;
    expect(await releases.refresh([8])).toBe('fresh');
    expect(await releases.refreshForced([8])).toBe('read');
    expect(php.urls).toHaveLength(2);
  });

  it('keeps the last list when php.net does not answer, and reads nothing while switched off', async () => {
    const store = memory();
    await new PhpReleases(store, answering().get).refresh();
    const before = store.meta.get(PHP_RELEASES_KEY);
    expect(await new PhpReleases(store, answering(503).get, () => Date.now() + 86_400_000).refresh()).toBe('failed');
    expect(await new PhpReleases(store, async () => { throw new Error('offline'); }, () => Date.now() + 86_400_000).refresh()).toBe('failed');
    expect(await new PhpReleases(store, answering(200, { nothing: 'here' }).get, () => Date.now() + 86_400_000).refresh()).toBe('failed');
    expect(store.meta.get(PHP_RELEASES_KEY)).toBe(before);
    const off = memory({ checkPhpReleases: false });
    const php = answering();
    const releases = new PhpReleases(off, php.get);
    expect(await releases.refresh()).toBe('off');
    expect(php.urls).toEqual([]);
    expect(releases.kept()).toBeNull();
  });
});

describe('Machine checks', () => {
  function treeWith(versions: string[]) {
    const tree = tempTree();
    for (const v of versions) {
      mkdirSync(join(tree.config.PHP_CONF_DIR, v, 'mods-available'), { recursive: true });
      mkdirSync(join(tree.config.PHP_CONF_DIR, v, 'fpm', 'conf.d'), { recursive: true });
      mkdirSync(join(tree.config.PHP_LIB_DIR, v, 'sapi'), { recursive: true });
      writeFileSync(join(tree.config.PHP_LIB_DIR, v, 'sapi', 'fpm'), '');
    }
    return tree;
  }
  const policy = (v: string, installed: string, candidate: string) => `php${v}-common:\n  Installed: ${installed}\n  Candidate: ${candidate}\n`;
  const kept = { at: '2026-11-19T12:00:00.000Z', releases: RELEASES };

  it('warns once a security release has been out a day without apt having it, with apt\'s refresh as the fix', async () => {
    const tree = treeWith(['8.4']);
    const { exec } = fakeExec({
      'php -r': { stdout: '8.4.27' },
      'php -m': { stdout: 'curl\ngd\nintl\nmbstring\nmysqli\nxml\nzip\nimagick\n' },
      'apt-cache pkgnames php': { stdout: 'php8.4-common\n' },
      'apt-cache policy php8.4-common': { stdout: policy('8.4', SURY('8.4.27'), SURY('8.4.27')) },
    });
    const check = async (now: string) =>
      (await checkEnvironment({ config: tree.config, exec, secrets: null, paths: tree.hostPaths, dmpRoot: DMP, phpReleases: () => kept, apt: { paths: { sourcesDir: tree.root, osRelease: tree.root, listsDir: join(tree.root, 'none'), updateStamp: join(tree.root, 'none') }, now: () => Date.parse(now) } })).checks.find((c) => c.id === 'php.releases');
    expect(await check('2026-11-19T20:00:00Z')).toMatchObject({ status: 'info', detail: expect.stringContaining('PHP 8.4.28 (security) is out on php.net since 2026-11-19') });
    expect(await check('2026-11-21T08:00:00Z')).toMatchObject({ status: 'warn', fixes: [{ action: 'system.aptUpdate', needsPassword: true }] });
  });

  it('says nothing for the system\'s own PHP, or without a list', async () => {
    const tree = treeWith(['8.3']);
    const { exec } = fakeExec({
      'php -r': { stdout: '8.3.6' },
      'php -m': { stdout: 'curl\ngd\nintl\nmbstring\nmysqli\nxml\nzip\nimagick\n' },
      'apt-cache pkgnames php': { stdout: 'php8.3-common\n' },
      'apt-cache policy php8.3-common': { stdout: policy('8.3', '8.3.6-0ubuntu0.24.04.5', '8.3.6-0ubuntu0.24.04.5') },
    });
    const run = (phpReleases?: () => typeof kept | null) => checkEnvironment({ config: tree.config, exec, secrets: null, paths: tree.hostPaths, dmpRoot: DMP, ...(phpReleases ? { phpReleases } : {}) });
    expect((await run(() => kept)).checks.find((c) => c.id === 'php.releases')).toBeUndefined();
    expect((await run()).checks.find((c) => c.id === 'php.releases')).toBeUndefined();
  });
});

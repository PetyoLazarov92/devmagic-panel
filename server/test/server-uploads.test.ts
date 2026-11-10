import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { actions, productionSettings } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { PASSWORD_OPTIONS, withSshPassword } from '../src/sites/ssh-password.js';
import { copyUploads, monthFilters, recentFolders, UPLOADS_LEFT_OUT } from '../src/sites/server-uploads.js';
import { fakeExec, wpSiteTree } from './helpers.js';

const src = { host: 'deploy@www.spellbook.example:2222', folder: '/srv/www/spellbook' };
const NOW = new Date('2026-11-10T08:00:00Z');

function server(kb = 2_000_000, rsync: Partial<{ code: number; stdout: string; stderr: string }> = { stdout: 'Number of regular files transferred: 1,204\nTotal transferred file size: 734,003,200 bytes\n' }) {
  return fakeExec({
    ssh: (call) => {
      const words = call.args.join(' ');
      if (words.includes(' plugin path')) return { stdout: '/srv/www/spellbook/wp-content/plugins\n' };
      if (words.includes(' du -sk')) return { stdout: `${kb}\t/srv/www/spellbook/wp-content/uploads\n` };
      return { code: 1, stderr: 'not faked' };
    },
    rsync,
  });
}

describe('uploads from the server', () => {
  it('names the last months as WordPress names their folders, across a new year, on every site of a network', () => {
    expect(recentFolders(3, new Date('2026-01-15T00:00:00Z'))).toEqual(['2026/01', '2025/12', '2025/11']);
    const filters = monthFilters(2, new Date('2026-01-15T00:00:00Z'));
    expect(filters).toEqual(expect.arrayContaining(['--include=/2026/', '--include=/2025/', '--include=/2026/01/***', '--include=/2025/12/***', '--include=/sites/*/2026/01/***']));
    expect(filters.at(-1)).toBe('--exclude=*');
  });

  it('reads where and how much with WP-CLI and du, then brings the files with rsync, only adding', async () => {
    const t = wpSiteTree();
    const fake = server();
    const results = await copyUploads(fake.exec, t.docroot, src, undefined, NOW);
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(results[0]?.stdout).toContain('deploy@www.spellbook.example:2222 has 1.9 GB in /srv/www/spellbook/wp-content/uploads');
    expect(results[1]?.stdout).toContain('copied 1204 files (700 MB) into wp-content/uploads');
    const rsync = fake.calls.find((c) => c.file === 'rsync')?.args ?? [];
    expect(rsync).toEqual(expect.arrayContaining(['--ignore-existing', '--no-links', '--partial', '--exclude=*.php', '--exclude=.htaccess', '--exclude=/cache/']));
    // Nothing that deletes or writes over, here or there.
    expect(rsync.some((a) => /^--(delete|remove-source|inplace|backup)/.test(a))).toBe(false);
    // The server's port goes to ssh, the folder there ends in a slash, and the files land in the site's own uploads.
    expect(rsync[rsync.indexOf('-e') + 1]).toMatch(/^ssh -o BatchMode=yes .*StrictHostKeyChecking=yes.* -p 2222$/);
    expect(rsync.slice(-3)).toEqual(['--', 'deploy@www.spellbook.example:/srv/www/spellbook/wp-content/uploads/', `${join(t.docroot, 'wp-content/uploads')}/`]);
    expect(existsSync(join(t.docroot, 'wp-content/uploads'))).toBe(true);
    // Only reads on the server.
    expect(fake.calls.filter((c) => c.file === 'ssh').map((c) => c.args.slice(c.args.indexOf('--') + 2).join(' '))).toEqual(['wp --path=/srv/www/spellbook plugin path --skip-plugins --skip-themes', 'du -sk -- /srv/www/spellbook/wp-content/uploads']);
  });

  it('brings only the months asked for', async () => {
    const t = wpSiteTree();
    const fake = server();
    await copyUploads(fake.exec, t.docroot, src, 2, NOW);
    const rsync = fake.calls.find((c) => c.file === 'rsync')?.args ?? [];
    expect(rsync).toEqual(expect.arrayContaining(['--include=/2026/11/***', '--include=/2026/10/***', '--exclude=*']));
    expect(rsync).not.toContain('--include=/2026/09/***');
    // The folders left out everywhere come before the months, so a month never brings them back.
    expect(rsync.indexOf(`--exclude=${UPLOADS_LEFT_OUT[0]}`)).toBeLessThan(rsync.indexOf('--include=/2026/11/***'));
  });

  it('refuses what would not fit, a link in place of the folder, and says what rsync lacks', async () => {
    const t = wpSiteTree();
    const huge = server(900_000_000_000);
    const out = await copyUploads(huge.exec, t.docroot, src, undefined, NOW);
    expect(out.at(-1)).toMatchObject({ code: 1, stderr: expect.stringContaining('not copied. Bring only the last months instead') });
    expect(huge.calls.some((c) => c.file === 'rsync')).toBe(false);
    const none = server(1000, { code: 12, stderr: 'bash: line 1: rsync: command not found\nrsync error: error in rsync protocol data stream (code 12)' });
    expect((await copyUploads(none.exec, t.docroot, src, undefined, NOW)).at(-1)).toMatchObject({ code: 1, stderr: 'deploy@www.spellbook.example:2222 has no rsync, which this copy needs on both sides' });
    const linked = wpSiteTree();
    mkdirSync(join(linked.root, 'elsewhere'));
    symlinkSync(join(linked.root, 'elsewhere'), join(linked.docroot, 'wp-content/uploads'));
    const fake = server();
    expect(await copyUploads(fake.exec, linked.docroot, src, undefined, NOW)).toEqual([{ code: 1, stdout: '', stderr: expect.stringContaining('is not a folder of this site') }]);
    expect(fake.calls).toEqual([]);
  });

  it('signs the ssh that rsync starts in with the password, through the helper and never an argument', async () => {
    const t = wpSiteTree();
    const runtimeDir = join(t.root, 'run');
    mkdirSync(runtimeDir);
    const fake = fakeExec({ mkfifo: {}, rsync: {} });
    await withSshPassword({ exec: fake.exec, runtimeDir, feed: async () => undefined }, 'correct horse battery', (exec) => exec('rsync', ['--recursive', '-e', 'ssh -o BatchMode=yes -p 2222', '--', 'h:/a/', '/b/']));
    const call = fake.calls.find((c) => c.file === 'rsync');
    expect(call?.args[2]).toBe(`ssh ${PASSWORD_OPTIONS.join(' ')} -o BatchMode=yes -p 2222`);
    expect(call?.env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force' });
    expect(JSON.stringify(call)).not.toContain('correct horse battery');
  });

  it('is off unless asked for, in the action and in the saved settings', () => {
    expect(productionSettings.parse({ host: 'spellbook-prod', folder: '/srv/www/spellbook' }).uploads).toBe(false);
    const input = actions['site.copyUploads'].input;
    expect(input.safeParse({ domain: 'local.spellbook.test', host: 'spellbook-prod', folder: '/srv/www/spellbook', months: 6 }).success).toBe(true);
    expect(input.safeParse({ domain: 'local.spellbook.test', host: 'spellbook-prod', folder: '/srv/www/$(id)' }).success).toBe(false);
    expect(input.safeParse({ domain: 'local.spellbook.test', host: 'spellbook-prod', folder: '/srv/www/spellbook', months: 0 }).success).toBe(false);
    expect(actions['site.create'].input.safeParse({ source: 'wordpress', domain: 'local.spellbook.test' }).data?.copyUploads).toBeUndefined();
  });
});

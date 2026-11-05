import { actions } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../src/exec.js';
import type { JobRuntime } from '../src/jobs.js';
import { planAddNetworkAdmin, readNetworkAdmins } from '../src/sites/network-admin.js';
import { SiteActionRefused, type SiteRef } from '../src/sites/site-actions.js';
import { fakeExec } from './helpers.js';

const site = (multisite = true) =>
  ({ domain: 'local.acme.com', host: 'local.acme.com', key: 'local.acme.com', docroot: '/var/www/local.acme.com', names: ['local.acme.com'], wp: { multisite, subdomainInstall: false } }) as unknown as SiteRef;
const WP = 'wp --path=/var/www/local.acme.com --url=https://local.acme.com/ eval-file -';

/** A job runtime that keeps what a step registers for Undo. */
function runtime() {
  const undo: Array<{ label: string; run: () => Promise<ExecResult | ExecResult[]> }> = [];
  const job: JobRuntime = { onUndo: (label, run) => void undo.push({ label, run }), progress: () => undefined };
  return { job, undo };
}

describe('readNetworkAdmins', () => {
  it('reads each super admin with the sites they have a role on, without plugins, from fixed PHP on stdin', async () => {
    const fake = fakeExec({ [WP]: { stdout: 'PHP Warning:  a plugin said something\n{"sites":80,"admins":[{"login":"admin","member":2},{"login":"netadmin","member":80}]}' } });
    expect(await readNetworkAdmins(fake.exec, site())).toEqual({ sites: 80, admins: [{ login: 'admin', member: 2 }, { login: 'netadmin', member: 80 }] });
    expect(fake.calls[0]?.args.slice(2)).toEqual(['eval-file', '-', '--skip-plugins', '--skip-themes']);
    expect(fake.calls[0]?.input).toContain("get_sites( array( 'number' => 0, 'deleted' => 0, 'fields' => 'ids' ) )");
    expect(fake.calls[0]?.input).toContain('get_super_admins()');
  });

  it('refuses a site that is not a network, and says what WP-CLI answered when it fails', async () => {
    await expect(readNetworkAdmins(fakeExec().exec, site(false))).rejects.toThrow('local.acme.com is not a network');
    const failing = fakeExec({ [WP]: { code: 1, stderr: 'Error: Error establishing a database connection.\n' } });
    await expect(readNetworkAdmins(failing.exec, site())).rejects.toThrow(new SiteActionRefused('WP-CLI could not read the super admins: Error: Error establishing a database connection.'));
  });
});

describe('planAddNetworkAdmin', () => {
  it('adds the role where there is none, passes the login only as an argument, and Undo takes it off those sites only', async () => {
    const fake = fakeExec({ [`${WP} admin`]: { stdout: '{"added":[3,4,12]}' }, [`${WP} admin 3,4,12`]: { stdout: '3' } });
    const [step] = planAddNetworkAdmin(fake.exec, site(), 'admin');
    const { job, undo } = runtime();
    expect(await step?.run(job)).toEqual({ code: 0, stdout: 'admin is administrator on 3 more sites: #3, #4, #12', stderr: '' });
    expect(fake.calls[0]?.args.slice(2)).toEqual(['eval-file', '-', 'admin']);
    expect(fake.calls[0]?.input).toContain("add_user_to_blog( (int) $dmp_site->blog_id, $dmp_user->ID, 'administrator' )");
    expect(fake.calls[0]?.input).toContain('is_super_admin( $dmp_user->ID )');
    expect(fake.calls[0]?.input).not.toContain('admin\'');
    expect(undo.map((u) => u.label)).toEqual(['Take admin off the 3 sites it was added to']);
    expect(await undo[0]?.run()).toEqual({ code: 0, stdout: 'took admin off 3 sites', stderr: '' });
    expect(fake.calls[1]?.input).toContain('remove_user_from_blog( $dmp_user->ID, $dmp_id )');
  });

  it('registers no Undo when it had nothing to add, and fails with what WP-CLI said', async () => {
    const none = fakeExec({ [`${WP} netadmin`]: { stdout: '{"added":[]}' } });
    const { job, undo } = runtime();
    expect((await planAddNetworkAdmin(none.exec, site(), 'netadmin')[0]?.run(job)) as ExecResult).toMatchObject({ code: 0, stdout: 'netadmin already has a role on every site' });
    expect(undo).toEqual([]);
    const refused = fakeExec({ [`${WP} editor`]: { code: 1, stderr: 'Error: not a super admin of this network\n' } });
    expect((await planAddNetworkAdmin(refused.exec, site(), 'editor')[0]?.run(job)) as ExecResult).toMatchObject({ code: 1, stderr: 'Error: not a super admin of this network\n' });
    expect(() => planAddNetworkAdmin(none.exec, site(false), 'admin')).toThrow('not a network');
  });

  it('takes no login WP-CLI would read as one of its own options', () => {
    const input = actions['network.addAdmin'].input;
    expect(input.safeParse({ domain: 'local.acme.com', user: 'admin' }).success).toBe(true);
    expect(input.safeParse({ domain: 'local.acme.com', user: 'Alex Morgan' }).success).toBe(true);
    expect(input.safeParse({ domain: 'local.acme.com', user: '--skip-plugins' }).success).toBe(false);
    expect(input.safeParse({ domain: 'local.acme.com', user: 'admin;id' }).success).toBe(false);
  });
});

import type { NetworkAdmins } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from '../exec.js';
import type { JobStep } from '../jobs.js';
import { wpCommand } from '../php/pools.js';
import { SiteActionRefused, type SiteRef } from './site-actions.js';

/**
 * A network's super admins can manage every site, but My Sites and plugins
 * that look for the administrator role only see the sites where they have a
 * role. These read the super admins with how many sites they have a role on,
 * and give one the administrator role where they have none. The PHP is fixed
 * and goes to `wp eval-file -` on stdin; the login only ever arrives in $args.
 * Sites deleted in Network Admin are left out: their tables may be gone.
 */

const READ_PHP = `<?php
$dmp_sites = array_map( 'intval', get_sites( array( 'number' => 0, 'deleted' => 0, 'fields' => 'ids' ) ) );
$dmp_out   = array( 'sites' => count( $dmp_sites ), 'admins' => array() );
foreach ( get_super_admins() as $dmp_login ) {
	$dmp_user = get_user_by( 'login', $dmp_login );
	if ( ! $dmp_user ) {
		continue;
	}
	$dmp_member          = array_map( 'intval', array_keys( get_blogs_of_user( $dmp_user->ID, true ) ) );
	$dmp_out['admins'][] = array( 'login' => $dmp_login, 'member' => count( array_intersect( $dmp_sites, $dmp_member ) ) );
}
echo wp_json_encode( $dmp_out );
`;

const ADD_PHP = `<?php
$dmp_user = get_user_by( 'login', (string) ( $args[0] ?? '' ) );
if ( ! $dmp_user || ! is_super_admin( $dmp_user->ID ) ) {
	WP_CLI::error( 'not a super admin of this network' );
}
$dmp_added = array();
foreach ( get_sites( array( 'number' => 0, 'deleted' => 0 ) ) as $dmp_site ) {
	if ( is_user_member_of_blog( $dmp_user->ID, (int) $dmp_site->blog_id ) ) {
		continue;
	}
	$dmp_result = add_user_to_blog( (int) $dmp_site->blog_id, $dmp_user->ID, 'administrator' );
	if ( is_wp_error( $dmp_result ) ) {
		WP_CLI::warning( 'site ' . $dmp_site->blog_id . ': ' . $dmp_result->get_error_message() );
		continue;
	}
	$dmp_added[] = (int) $dmp_site->blog_id;
}
echo wp_json_encode( array( 'added' => $dmp_added ) );
`;

/** Takes the user off the sites Undo names ($args[1], comma separated), and only those. */
const REMOVE_PHP = `<?php
$dmp_user = get_user_by( 'login', (string) ( $args[0] ?? '' ) );
if ( ! $dmp_user ) {
	WP_CLI::error( 'no such user' );
}
$dmp_removed = 0;
foreach ( array_filter( array_map( 'intval', explode( ',', (string) ( $args[1] ?? '' ) ) ) ) as $dmp_id ) {
	if ( is_user_member_of_blog( $dmp_user->ID, $dmp_id ) && true === remove_user_from_blog( $dmp_user->ID, $dmp_id ) ) {
		++$dmp_removed;
	}
}
echo (int) $dmp_removed;
`;

function evalPhp(exec: Executor, site: SiteRef, php: string, args: string[], extra: string[] = []): Promise<ExecResult> {
  const cmd = wpCommand(site.php, [`--path=${site.docroot}`, `--url=https://${site.host}/`, 'eval-file', '-', ...args, ...extra]);
  return exec(cmd.file, cmd.args, { input: php, timeoutMs: 300_000, ...(cmd.env ? { env: cmd.env } : {}) });
}

/** The last line of what WP-CLI said, for a short reason. */
const lastLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';

export async function readNetworkAdmins(exec: Executor, site: SiteRef): Promise<NetworkAdmins> {
  if (!site.wp.multisite) throw new SiteActionRefused(`${site.host} is not a network`);
  // Plugins and themes stay off: reading needs none of them, and some print warnings or take long to load.
  const r = await evalPhp(exec, site, READ_PHP, [], ['--skip-plugins', '--skip-themes']);
  if (r.code !== 0) throw new SiteActionRefused(`WP-CLI could not read the super admins: ${lastLine(r)}`);
  try {
    const data = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as NetworkAdmins;
    return { sites: Number(data.sites) || 0, admins: (data.admins ?? []).map((a) => ({ login: String(a.login), member: Number(a.member) || 0 })) };
  } catch {
    throw new SiteActionRefused('WP-CLI answered in a form the panel cannot read');
  }
}

/** One step that gives `login` the administrator role on every site where they have none; Undo takes them off those sites only. */
export function planAddNetworkAdmin(exec: Executor, site: SiteRef, login: string): JobStep[] {
  if (!site.wp.multisite) throw new SiteActionRefused(`${site.host} is not a network`);
  return [
    {
      id: 'members',
      label: `Make ${login} administrator on every site of the network`,
      // With plugins loaded, as WordPress itself would add a member: plugins may act on a new member.
      run: async (job) => {
        const r = await evalPhp(exec, site, ADD_PHP, [login]);
        if (r.code !== 0) return { ...r, stderr: `${lastLine(r)}\n` };
        let added: number[];
        try {
          added = (JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as { added: number[] }).added.map(Number).filter((n) => Number.isInteger(n) && n > 0);
        } catch {
          return { code: 1, stdout: '', stderr: 'WP-CLI answered in a form the panel cannot read\n' };
        }
        if (added.length === 0) return { code: 0, stdout: `${login} already has a role on every site`, stderr: '' };
        job.onUndo(`Take ${login} off the ${added.length} site${added.length === 1 ? '' : 's'} it was added to`, async () => {
          const back = await evalPhp(exec, site, REMOVE_PHP, [login, added.join(',')]);
          return back.code === 0 ? { code: 0, stdout: `took ${login} off ${back.stdout.trim().split('\n').at(-1)} sites`, stderr: '' } : back;
        });
        return { code: 0, stdout: `${login} is administrator on ${added.length} more site${added.length === 1 ? '' : 's'}: ${added.map((id) => `#${id}`).join(', ')}`, stderr: '' };
      },
    },
  ];
}

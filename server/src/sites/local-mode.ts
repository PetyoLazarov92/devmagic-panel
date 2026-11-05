import { existsSync, readFileSync } from 'node:fs';
import type { SiteLocalMode } from '@devmagic-panel/shared';
import { hostname, LOCAL_MODE_DEFAULT_BLOCKED_HOSTS, MAILPIT_SMTP, MAILPIT_WEB } from '@devmagic-panel/shared';
import type { ExecResult, Executor } from '../exec.js';
import { installMuPlugin, muPluginPath, removeMuPlugin } from './mu-plugins.js';

export const LOCAL_MODE_FILE = 'devmagic-panel-local.php';

const BLOCKED_LINE = /^const DMP_LOCAL_MODE_BLOCKED_HOSTS = array\((.*)\);$/m;
const UPLOADS_LINE = /^const DMP_LOCAL_MODE_UPLOADS_FROM = '([^']*)';$/m;

/**
 * The Local mode mu-plugin. It only acts when the site's own address is a
 * local name, so a copy that reaches production by mistake does nothing.
 * Blocked hosts and the uploads host are validated hostnames, safe inside single quotes.
 */
export function localModePlugin(blockedHosts: readonly string[], uploadsFrom: string | null = null): string {
  const hosts = blockedHosts.map((h) => {
    if (!hostname.safeParse(h).success) throw new Error(`not a hostname: ${h}`);
    return `'${h}'`;
  });
  if (uploadsFrom !== null && !hostname.safeParse(uploadsFrom).success) throw new Error(`not a hostname: ${uploadsFrom}`);
  return `<?php
/**
 * Plugin Name: devmagic-panel Local mode
 * Description: Keeps this local copy from reaching real people: mail goes to Mailpit, search engines are told not to index, a Local label shows in the admin bar, chosen outgoing hosts are blocked and logins work from this computer only. Plugins and themes update without FTP details, missing uploads can load from production, and a long My Sites menu scrolls and has a filter. Added by devmagic-panel and excluded from git locally.
 * Version: 4
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const DMP_LOCAL_MODE_BLOCKED_HOSTS = array(${hosts.length ? ` ${hosts.join(', ')} ` : ''});
const DMP_LOCAL_MODE_UPLOADS_FROM = '${uploadsFrom ?? ''}';

$dmp_local_host = strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) );
if ( ! preg_match( '/^(www\\.)?local\\.|\\.test$|\\.localhost$/', $dmp_local_host ) ) {
	return;
}
unset( $dmp_local_host );

// Plugin and theme installs and updates write files directly instead of asking for FTP details.
if ( ! defined( 'FS_METHOD' ) ) {
	define( 'FS_METHOD', 'direct' );
}

// A missing upload loads from production. WordPress's .htaccess hands a missing file to WordPress, so it ends up here.
if ( '' !== DMP_LOCAL_MODE_UPLOADS_FROM && isset( $_SERVER['REQUEST_URI'] ) ) {
	$dmp_path = (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ), PHP_URL_PATH );
	if ( 0 === strpos( $dmp_path, '/wp-content/uploads/' ) && false === strpos( $dmp_path, '..' ) && ! file_exists( ABSPATH . ltrim( $dmp_path, '/' ) ) ) {
		header( 'Location: https://' . DMP_LOCAL_MODE_UPLOADS_FROM . $dmp_path, true, 302 );
		exit;
	}
	unset( $dmp_path );
}

// Every message goes to Mailpit, whatever an SMTP plugin set before, tagged with this site so the panel can show its mail.
add_action(
	'phpmailer_init',
	static function ( $phpmailer ) {
		$phpmailer->addCustomHeader( 'X-Tags', (string) wp_parse_url( home_url(), PHP_URL_HOST ) );
		$phpmailer->isSMTP();
		$phpmailer->Host        = '${MAILPIT_SMTP.host}';
		$phpmailer->Port        = ${MAILPIT_SMTP.port};
		$phpmailer->SMTPAuth    = false;
		$phpmailer->SMTPSecure  = '';
		$phpmailer->SMTPAutoTLS = false;
	},
	PHP_INT_MAX
);

// Apache answers on every network address, so a known local password must not work from another machine.
$dmp_from_here = 'cli' === PHP_SAPI || in_array( (string) ( $_SERVER['REMOTE_ADDR'] ?? '' ), array( '127.0.0.1', '::1', '::ffff:127.0.0.1' ), true ) || 0 === strpos( (string) ( $_SERVER['REMOTE_ADDR'] ?? '' ), '127.' );
if ( ! $dmp_from_here ) {
	add_filter(
		'authenticate',
		static function () {
			return new WP_Error( 'dmp_local_mode_remote_login', 'This local copy only accepts logins from the computer it runs on.' );
		},
		PHP_INT_MAX
	);
	add_filter( 'wp_is_application_passwords_available', '__return_false', PHP_INT_MAX );
}
unset( $dmp_from_here );

add_filter( 'wp_robots', 'wp_robots_no_robots' );
add_action(
	'send_headers',
	static function () {
		header( 'X-Robots-Tag: noindex, nofollow', true );
	}
);

// Mail APIs and other chosen services never get a request from this copy.
add_filter(
	'pre_http_request',
	static function ( $response, $args, $url ) {
		$host = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
		foreach ( DMP_LOCAL_MODE_BLOCKED_HOSTS as $blocked ) {
			if ( $host === $blocked || substr( $host, -strlen( $blocked ) - 1 ) === '.' . $blocked ) {
				return new WP_Error( 'dmp_local_mode_blocked', sprintf( 'devmagic-panel Local mode blocked a request to %s.', $host ) );
			}
		}
		return $response;
	},
	PHP_INT_MAX,
	3
);

// A quiet Local label right after the site name; it opens Mailpit.
add_action(
	'admin_bar_menu',
	static function ( $bar ) {
		$bar->add_node(
			array(
				'id'    => 'dmp-local',
				'title' => '<span class="dmp-local-label">Local</span>',
				'href'  => '${MAILPIT_WEB}',
				'meta'  => array(
					'title'  => 'Local copy: mail goes to Mailpit. Click to open it.',
					'target' => '_blank',
				),
			)
		);
	},
	31
);

$dmp_local_badge = static function () {
	if ( is_admin_bar_showing() ) {
		echo '<style>#wpadminbar #wp-admin-bar-dmp-local .dmp-local-label { display: inline-block; vertical-align: middle; padding: 0 7px; border: 1px solid rgba(251, 191, 36, .5); border-radius: 9px; background: rgba(245, 158, 11, .14); color: #fcd34d; font-size: 11px; font-weight: 500; line-height: 18px; letter-spacing: .02em; } #wpadminbar #wp-admin-bar-dmp-local:hover .dmp-local-label { background: rgba(245, 158, 11, .26); }</style>';
	}
};
add_action( 'wp_head', $dmp_local_badge );
add_action( 'admin_head', $dmp_local_badge );
unset( $dmp_local_badge );

// On a network, My Sites fits the window and scrolls, its side menus stay visible, and a long list gets a filter.
if ( is_multisite() ) {
	$dmp_my_sites = static function () {
		if ( ! is_admin_bar_showing() ) {
			return;
		}
		?>
<style>#wpadminbar #wp-admin-bar-my-sites > .ab-sub-wrapper { max-height: calc(100vh - var(--wp-admin--admin-bar--height, 32px)); overflow-y: auto; overscroll-behavior: contain; } #wpadminbar #wp-admin-bar-my-sites:focus-within > .ab-sub-wrapper { display: block; } #wpadminbar #wp-admin-bar-dmp-site-filter { padding: 6px 10px; } #wpadminbar #wp-admin-bar-dmp-site-filter input { box-sizing: border-box; width: 100%; min-width: 180px; height: 28px; margin: 0; padding: 0 8px; border: 1px solid #50575e; border-radius: 3px; background: #1d2327; color: #f0f0f1; font-size: 13px; line-height: 26px; }</style>
<script>
document.addEventListener( 'DOMContentLoaded', function () {
	var list = document.getElementById( 'wp-admin-bar-my-sites-list' );
	if ( ! list ) {
		return;
	}
	var wrap = list.parentNode;
	var current = null;
	// The list scrolls, which would cut off each site's side menu: it opens fixed beside its row instead.
	function place( li ) {
		var sub = li.querySelector( '.ab-sub-wrapper' );
		if ( ! sub ) {
			return;
		}
		var row = li.getBoundingClientRect();
		sub.style.position = 'fixed';
		sub.style.margin = '0';
		var width = sub.offsetWidth || 160;
		var height = sub.offsetHeight || 0;
		sub.style.left = ( row.right + width > window.innerWidth ? Math.max( 0, row.left - width ) : row.right ) + 'px';
		sub.style.top = Math.max( 0, Math.min( row.top, window.innerHeight - height ) ) + 'px';
	}
	wrap.addEventListener( 'mouseover', function ( event ) {
		var li = event.target.closest ? event.target.closest( 'li.menupop' ) : null;
		if ( li && li.parentNode.parentNode === wrap ) {
			current = li;
			place( li );
		}
	} );
	wrap.addEventListener( 'scroll', function () {
		if ( current ) {
			place( current );
		}
	} );
	var items = Array.prototype.filter.call( list.children, function ( item ) {
		return item.tagName === 'LI';
	} );
	if ( items.length < 10 ) {
		return;
	}
	var row = document.createElement( 'li' );
	row.id = 'wp-admin-bar-dmp-site-filter';
	var input = document.createElement( 'input' );
	input.type = 'search';
	input.placeholder = 'Filter ' + items.length + ' sites';
	input.setAttribute( 'aria-label', 'Filter sites' );
	row.appendChild( input );
	list.insertBefore( row, list.firstChild );
	function visible() {
		return items.filter( function ( item ) {
			return item.style.display !== 'none';
		} );
	}
	input.addEventListener( 'input', function () {
		var query = input.value.trim().toLowerCase();
		items.forEach( function ( item ) {
			var link = item.querySelector( '.ab-item' );
			var text = link ? ( link.textContent + ' ' + ( link.getAttribute( 'href' ) || '' ) ).toLowerCase() : '';
			item.style.display = ! query || text.indexOf( query ) !== -1 ? '' : 'none';
		} );
	} );
	input.addEventListener( 'keydown', function ( event ) {
		if ( event.key === 'Enter' ) {
			var first = visible()[0];
			var link = first ? first.querySelector( 'a.ab-item' ) : null;
			if ( link ) {
				window.location.href = link.href;
			}
		} else if ( event.key === 'Escape' && input.value ) {
			event.stopPropagation();
			input.value = '';
			input.dispatchEvent( new Event( 'input' ) );
		}
	} );
} );
</script>
		<?php
	};
	add_action( 'wp_head', $dmp_my_sites );
	add_action( 'admin_head', $dmp_my_sites );
	unset( $dmp_my_sites );
}
`;
}

/** Local mode as it is on disk: on when the file exists, current when it matches what the panel writes. */
export function readLocalMode(docroot: string): SiteLocalMode {
  const file = muPluginPath(docroot, LOCAL_MODE_FILE);
  if (!existsSync(file)) return { enabled: false, current: true, blockedHosts: [] };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { enabled: true, current: false, blockedHosts: [] };
  }
  const list = BLOCKED_LINE.exec(text)?.[1] ?? '';
  const blockedHosts = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] as string).filter((h) => hostname.safeParse(h).success);
  const uploads = UPLOADS_LINE.exec(text)?.[1];
  const uploadsFrom = uploads && hostname.safeParse(uploads).success ? uploads : null;
  return { enabled: true, current: text === localModePlugin(blockedHosts, uploadsFrom), blockedHosts, ...(uploadsFrom ? { uploadsFrom } : {}) };
}

export async function setLocalMode(
  exec: Executor,
  docroot: string,
  enabled: boolean,
  blockedHosts?: readonly string[],
  /** The production host for missing uploads, null for none; left out, the current one stays. */
  uploadsFrom?: string | null,
): Promise<ExecResult> {
  if (!enabled) return removeMuPlugin(docroot, LOCAL_MODE_FILE);
  const current = readLocalMode(docroot);
  const hosts = blockedHosts ?? (current.enabled ? current.blockedHosts : LOCAL_MODE_DEFAULT_BLOCKED_HOSTS);
  const uploads = uploadsFrom === undefined ? (current.uploadsFrom ?? null) : uploadsFrom;
  const result = await installMuPlugin(exec, docroot, LOCAL_MODE_FILE, localModePlugin([...new Set(hosts)], uploads), 'devmagic-panel Local mode, local only');
  return result.code === 0
    ? { ...result, stdout: `Local mode on: mail goes to Mailpit, ${hosts.length} host${hosts.length === 1 ? '' : 's'} blocked` }
    : result;
}

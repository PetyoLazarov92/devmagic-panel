/**
 * nginx next to Apache. Both answer on ports 80 and 443, each on its own
 * loopback address (nginx on 127.0.0.2, Apache on 127.0.0.1 by default), and
 * a site is served by the server its line in the hosts file points at.
 */

/** One config file of nginx's sites-available, as the nginx tab lists it. */
export interface NginxConfig {
  /** The file name in sites-available, like default or local.acme.com.conf. */
  file: string;
  /** Linked from sites-enabled, so nginx serves it. */
  enabled: boolean;
  /** Written by the panel: its first line is the panel's marker. */
  managed: boolean;
  /** server_name, as the file has them; _ is left out. */
  names: string[];
  /** What it listens on, like 127.0.0.2:443 ssl. */
  listens: string[];
  /** Set when an enabled config made by hand listens on port 80 or 443 off nginx's address, which keeps nginx from starting next to Apache. */
  conflict?: string;
}

export interface NginxReport {
  checkedAt: string;
  /** The nginx package is on the machine. */
  installed: boolean;
  /** The panel set nginx up next to Apache (its conf.d/devmagic-panel.conf is there). */
  setUp: boolean;
  /** Where each server answers once nginx is set up. */
  addresses: { nginx: string; apache: string };
  /** nginx -t through dmp-root; null ok when it could not run, like before the sudoers rule or without nginx. */
  configtest: { ok: boolean | null; output: string };
  server: {
    state: 'running' | 'stopped' | 'missing';
    /** nginx/1.24.0. */
    version?: string;
    /** When it last started, while it runs. */
    since?: string;
  };
  configs: NginxConfig[];
  /** nginx's own error log, for the log below. */
  errorLog: string;
}

/** What the new site wizard needs: whether a new site can run on nginx, and on which PHP-FPM version. */
export interface NginxState {
  setUp: boolean;
  /** The default PHP version's PHP-FPM, when it is installed. */
  php?: string;
}

/** The addresses the panel uses when config.env names none. */
export const DEFAULT_NGINX_ADDRESS = '127.0.0.2';
export const DEFAULT_APACHE_ADDRESS = '127.0.0.1';

/** An address in 127.0.0.0/8 but 127.0.1.1, which Debian gives the machine's own name; mirrors dmp_is_loopback_address in scripts/lib/config.sh. */
export function isLoopbackAddress(address: string): boolean {
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  return Boolean(m && address !== '127.0.1.1' && m.slice(1).every((o) => Number(o) <= 255));
}

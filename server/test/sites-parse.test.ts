import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseApacheErrorLog, parseDebugLog } from '../src/sites/logs.js';
import { parseVhost, VHOST_MARKER } from '../src/sites/vhost.js';
import { siteConstants } from '../src/sites/discover.js';
import { legacySaltNames, saltNames, saltStatus } from '../src/sites/salts.js';
import { parseWpConfig, parseWpVersion } from '../src/sites/wpconfig.js';

const northwindVhost = `# Northwind Localhost - Apache Configuration
<VirtualHost *:443>
    ServerName local.northwind.com
    ServerAlias local.northwind.de local.northwind.fr
    # ServerAlias local.commented.com
    DocumentRoot /var/www/local.northwind.com
    Alias /learn /var/www/local.learn.northwind.com
    SSLCertificateFile /etc/ssl/localcerts/local.northwind.com/local.northwind.com.crt
    ErrorLog \${APACHE_LOG_DIR}/error.log
</VirtualHost>
<VirtualHost *:80>
    ServerName local.northwind.com
    ServerAlias www.local.northwind.com
    RewriteEngine On
</VirtualHost>
`;

describe('parseVhost', () => {
  it('reads names from both blocks, the 443 docroot, cert, log and aliases', () => {
    const v = parseVhost(northwindVhost, '/etc/apache2/sites-available/x.conf', '/var/log/apache2');
    expect(v.names).toEqual(['local.northwind.com', 'local.northwind.de', 'local.northwind.fr', 'www.local.northwind.com']);
    expect(v.docroot).toBe('/var/www/local.northwind.com');
    expect(v.certFile).toBe('/etc/ssl/localcerts/local.northwind.com/local.northwind.com.crt');
    expect(v.errorLog).toBe('/var/log/apache2/error.log');
    expect(v.mounts).toEqual([{ path: '/learn', docroot: '/var/www/local.learn.northwind.com' }]);
    expect(v.managed).toBe(false);
  });

  it('knows the panel marker', () => {
    expect(parseVhost(`${VHOST_MARKER}\nServerName local.a.com\n`, 'f', '/l').managed).toBe(true);
  });

  it("reads the uploads host from the rule dmp-root writes, and nothing from other vhosts", () => {
    const rule = '    RewriteCond %{DOCUMENT_ROOT}%{REQUEST_URI} !-f\n    RewriteRule ^/?(.*)$ https://www.a.com/$1 [R=302,L]\n';
    expect(parseVhost(`${VHOST_MARKER}\nServerName local.a.com\n${rule}`, 'f', '/l').uploadsProxy).toBe('www.a.com');
    expect(parseVhost(northwindVhost, 'f', '/l').uploadsProxy).toBeNull();
  });
});

describe('parseWpConfig', () => {
  const php = `<?php
define( 'DB_NAME', 'biketoursdb' );
// define( 'DB_NAME', 'biketoursdbprod_2026_03_29' );
/* define( 'WP_DEBUG', false ); */
define( 'DB_HOST', 'localhost' );
$table_prefix = 'xyz_'; // local prefix
if ( ! defined( 'WP_DEBUG' ) ) {
\tdefine( 'WP_DEBUG', true );
}
define( 'WP_DEBUG_LOG', '/tmp/wp-errors.log' );
define( 'MULTISITE', true );
define( 'SUBDOMAIN_INSTALL', false );
define( 'DOMAIN_CURRENT_SITE', 'local.arcade.bet' );
define( 'WP_HOME', 'https://local.arcade.bet' ); // URL with // inside
define( 'DB_NAME', 'second_one_is_ignored' );
`;
  it('skips comments, takes the first definition and reads the network settings', () => {
    expect(parseWpConfig(php)).toEqual({
      dbName: 'biketoursdb',
      dbHost: 'localhost',
      tablePrefix: 'xyz_',
      multisite: true,
      subdomainInstall: false,
      domainCurrentSite: 'local.arcade.bet',
      debug: true,
      debugLog: '/tmp/wp-errors.log',
      debugConstants: { WP_DEBUG: true, WP_DEBUG_LOG: true },
      constants: [
        { name: 'DB_NAME', value: 'biketoursdb' },
        { name: 'DB_HOST', value: 'localhost' },
        { name: 'WP_DEBUG', value: true },
        { name: 'WP_DEBUG_LOG', value: '/tmp/wp-errors.log' },
        { name: 'MULTISITE', value: true },
        { name: 'SUBDOMAIN_INSTALL', value: false },
        { name: 'DOMAIN_CURRENT_SITE', value: 'local.arcade.bet' },
        { name: 'WP_HOME', value: 'https://local.arcade.bet' },
      ],
    });
  });

  it('lists every constant, digits in names too, with the PHP of a value that is not a plain one, and never the value of a secret', () => {
    const config = parseWpConfig("<?php\ndefine( 'ACME_2FA', 3 );\ndefine( 'ABSPATH', __DIR__ . '/' );\ndefine( 'DB_PASSWORD', 'hunter2' );\ndefine( 'NONCE_SALT', 'x' );\ndefine( 'ACME_API_KEY', 'k' );\n");
    expect(config.constants).toEqual([
      { name: 'ACME_2FA', value: 3 },
      { name: 'ABSPATH', code: "__DIR__ . '/'" },
      { name: 'DB_PASSWORD', value: 'hunter2' },
      { name: 'NONCE_SALT', value: 'x' },
      { name: 'ACME_API_KEY', value: 'k' },
    ]);
    expect(siteConstants(config)).toEqual([
      { name: 'ACME_2FA', value: 3 },
      { name: 'ABSPATH', code: "__DIR__ . '/'" },
      { name: 'DB_PASSWORD', hidden: true },
      { name: 'NONCE_SALT', hidden: true },
      { name: 'ACME_API_KEY', hidden: true },
    ]);
  });

  it('defaults to a plain, non-debug site', () => {
    expect(parseWpConfig('<?php ')).toMatchObject({ multisite: false, debug: false, debugLog: false });
  });

  it('reads the version from version.php', () => {
    expect(parseWpVersion("<?php\n$wp_version = '6.8.1';\n")).toBe('6.8.1');
  });
});

describe('parseDebugLog', () => {
  const log = `[23-Oct-2026 23:08:28 UTC] PHP Deprecated:  Creation of dynamic property is deprecated in /x.php on line 27
[23-Oct-2026 23:08:28 UTC] PHP Stack trace:
[23-Oct-2026 23:08:28 UTC] PHP   1. {main}() /var/www/wp-cores/7.1.3/wp-cron.php:0
[24-Oct-2026 08:13:27 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function foo() in /y.php:88
Stack trace:
#0 /z.php(12): bar()
  thrown in /y.php on line 88
[24-Oct-2026 08:14:00 UTC] WordPress database error Table 'db.wp_x' doesn't exist for query SELECT 1
`;
  it('folds stack traces into their entry, newest first, with levels and UTC times', () => {
    const lines = parseDebugLog(log);
    expect(lines.map((l) => l.level)).toEqual(['error', 'fatal', 'deprecated']);
    expect(lines[1]?.time).toBe('2026-10-24T08:13:27.000Z');
    expect(lines[1]?.message).toContain('#0 /z.php(12): bar()');
    expect(lines[2]?.message).toContain('PHP   1. {main}()');
  });
});

describe('parseApacheErrorLog', () => {
  const log = `[Sat Oct 24 02:08:51.160447 2026] [ssl:warn] [pid 10406] AH01909: server certificate does NOT include an ID
[Sat Oct 24 09:01:02.000001 2026] [php:error] [pid 11] [client 127.0.0.1:5000] PHP Fatal error:  boom in /var/www/local.a.com/x.php on line 1, referer: https://local.a.com/
[Sat Oct 24 09:02:00.000001 2026] [php:warn] [pid 11] [client 127.0.0.1:5000] PHP Warning:  hmm in /var/www/local.b.com/y.php on line 2
`;
  it('parses levels, strips the referer and filters by site', () => {
    const all = parseApacheErrorLog(log);
    expect(all.map((l) => l.level)).toEqual(['warning', 'fatal', 'warning']);
    expect(all[1]?.message).toBe('PHP Fatal error:  boom in /var/www/local.a.com/x.php on line 1');
    const onlyA = parseApacheErrorLog(log, (line) => line.includes('/var/www/local.a.com'));
    expect(onlyA).toHaveLength(1);
  });
});

describe('saltStatus', () => {
  it('tells missing keys, placeholders and copies apart, as wp_salt() does, with legacy SECRET_KEY counted for copies', () => {
    const config = parseWpConfig(
      "<?php\ndefine( 'AUTH_KEY', 'one' );\ndefine( 'SECURE_AUTH_KEY', 'put your unique phrase here' );\ndefine( 'LOGGED_IN_KEY', 'two' );\ndefine( 'NONCE_KEY', getenv( 'ACME_NONCE' ) );\ndefine( 'AUTH_SALT', 'three' );\ndefine( 'SECURE_AUTH_SALT', 'four' );\ndefine( 'LOGGED_IN_SALT', 'five' );\ndefine( 'SECRET_KEY', 'two' );\n",
    );
    expect(saltStatus(config, '/nowhere')).toEqual({
      names: ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'],
      missing: ['NONCE_SALT'],
      placeholder: ['SECURE_AUTH_KEY'],
      duplicate: ['LOGGED_IN_KEY'],
      legacy: ['SECRET_KEY'],
    });
  });
});

describe('values with code characters in them', () => {
  it('reads a key whose value holds ; ) // /* and #, and an escaped quote', () => {
    const php = "<?php\ndefine( 'AUTH_KEY', 'a;b)c//d/*e#f' );\ndefine( 'NONCE_KEY', 'it\\'s' ); // a comment\n# define( 'GONE', true );\ndefine( 'WP_DEBUG', true );\n";
    expect(parseWpConfig(php).constants).toEqual([
      { name: 'AUTH_KEY', value: 'a;b)c//d/*e#f' },
      { name: 'NONCE_KEY', value: "it's" },
      { name: 'WP_DEBUG', value: true },
    ]);
  });
});

describe('the key names a site asks for', () => {
  it("takes the current keys from its wp-config-sample.php and the legacy ones from its wp_salt(), else the known ones", () => {
    const docroot = mkdtempSync(join(tmpdir(), 'dmp-salts-'));
    expect(saltNames(docroot)).toHaveLength(8);
    expect(legacySaltNames(docroot, saltNames(docroot))).toEqual(['SECRET_KEY', 'SECRET_SALT']);
    writeFileSync(join(docroot, 'wp-config-sample.php'), "<?php\ndefine( 'AUTH_KEY', 'put your unique phrase here' );\ndefine( 'ACME_SALT', 'put your unique phrase here' );\n");
    mkdirSync(join(docroot, 'wp-includes'));
    writeFileSync(
      join(docroot, 'wp-includes', 'pluggable.php'),
      "<?php\nif ( ! function_exists( 'wp_salt' ) ) :\n\tfunction wp_salt( $scheme = 'auth' ) {\n\t\tif ( defined( \"{$first}_{$second}\" ) ) {}\n\t\tif ( defined( 'ACME_OLD_KEY' ) && defined( 'AUTH_KEY' ) ) {}\n\t}\nendif;\nif ( ! function_exists( 'wp_hash' ) ) :\n\tfunction wp_hash() { defined( 'NOT_A_KEY' ); }\nendif;\n",
    );
    expect(saltNames(docroot)).toEqual(['AUTH_KEY', 'ACME_SALT']);
    expect(legacySaltNames(docroot, saltNames(docroot))).toEqual(['ACME_OLD_KEY']);
  });
});

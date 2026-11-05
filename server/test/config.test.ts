import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const valid = [
  'PANEL_USER=dev', 'PANEL_GROUP=dev', 'PANEL_PORT=4710', 'PANEL_DOMAIN=local.devmagic', 'WEB_DIR=/var/www',
  'WEB_GROUP=www-data', 'CERTS_DIR=/etc/ssl/localcerts', 'CA_DIR=/etc/ssl/localcerts/devmagic-panel-ca',
  'APACHE_SITES_AVAILABLE=/etc/apache2/sites-available', 'APACHE_SITES_ENABLED=/etc/apache2/sites-enabled',
  'APACHE_LOG_DIR=/var/log/apache2', 'HOSTS_FILE=/etc/hosts', 'SYSTEM_CA_DIR=/usr/local/share/ca-certificates',
  'BACKUP_DIR=/home/dev/devmagic-panel-backups',
].join('\n');

describe('parseConfig', () => {
  it('reads the file install.sh writes', () => {
    const config = parseConfig(`# comment\n${valid}\n`, 'test');
    expect(config.PANEL_PORT).toBe(4710);
    expect(config.CA_DIR).toBe('/etc/ssl/localcerts/devmagic-panel-ca');
  });

  it('defaults PHP_CONF_DIR for files written before it existed, and reads it when set', () => {
    expect(parseConfig(valid, 'test').PHP_CONF_DIR).toBe('/etc/php');
    expect(parseConfig(`${valid}\nPHP_CONF_DIR=/opt/php`, 'test').PHP_CONF_DIR).toBe('/opt/php');
  });

  it('rejects shell syntax', () => {
    expect(() => parseConfig(`${valid}\nWEB_DIR=$(id)`, 'test')).toThrow(/invalid line/);
  });

  it('rejects unknown keys', () => {
    expect(() => parseConfig(`${valid}\nEXTRA=1`, 'test')).toThrow(/unknown key/);
  });

  it('rejects missing keys', () => {
    expect(() => parseConfig('PANEL_USER=dev', 'test')).toThrow(/missing key/);
  });
});

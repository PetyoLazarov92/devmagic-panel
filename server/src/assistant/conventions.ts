import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PRODUCTION_ONLY_PLUGINS } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import { readWpcoreConfig } from '../wpcore.js';

export const MAX_CONVENTIONS = 20_000;

/**
 * conventions.md as this machine is set up today. The assistant reads it
 * before it fills in the new site wizard; you edit it to match your team.
 */
export function defaultConventions(config: SystemConfig, wpcoreConf: string): string {
  const cores = readWpcoreConfig(wpcoreConf)?.coresDir ?? '/var/www/wp-cores';
  return `# Local site conventions

How sites are set up on this machine. The assistant reads this before it fills in the new site wizard. Edit it to match how your team works, and share it by copying the file to teammates.

## Domains

- The local domain is the production domain with \`local.\` in front, without \`www.\`: \`local.northwind.com\` for \`www.northwind.com\`.
- Every production domain of a site (other languages, network sites) gets its own local name on the same site. One cert, one vhost and one hosts line cover them all.
- Add \`www.local.\` as an alias only when the site links to it.
- Local names must be \`local.*\`, \`www.local.*\`, \`*.test\` or \`*.localhost\`.

## Folders and WordPress

- Sites live in \`${config.WEB_DIR}/<primary domain>\`.
- WordPress comes from the shared cores in \`${cores}\`, linked with wpcore. Use the core whose database version matches the dump, else the newest installed one.
- A site gets its own copy of WordPress only when its repo ships WordPress itself.

## Database

- The database and its user are named after the primary domain without \`local.\`: \`learn_northwind_com\` for \`local.learn.northwind.com\`.
- After an import, production URLs become their local names (email addresses keep the production domain unless every mention is replaced), and http:// on the local names becomes https://.
- The wizard lists the plugins active in the dump to deactivate; these are usually production only: ${PRODUCTION_ONLY_PLUGINS.join(', ')}.

## Config and uploads

- When the repo has \`wp-config-local-sample.php\`, wp-config.php starts from it.
- Missing uploads load from production through a redirect, so the dump is enough.
- Local mode is on for every new site: mail goes to Mailpit.

## Repos

- Clone over SSH (\`git@github.com:team/repo.git\`).
- A repo's own README and CLAUDE.md win over this file.
`;
}

export function readConventions(file: string, config: SystemConfig, wpcoreConf: string): { text: string; saved: boolean } {
  return existsSync(file) ? { text: readFileSync(file, 'utf8').slice(0, MAX_CONVENTIONS), saved: true } : { text: defaultConventions(config, wpcoreConf), saved: false };
}

export function writeConventions(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o644 });
}

import { existsSync, readFileSync } from 'node:fs';
import type { AuraItem, AuraReport, CompatScan, LocalConstant, Site } from '@devmagic-panel/shared';
import { isLocalName, MAILPIT_SMTP } from '@devmagic-panel/shared';
import type { SystemConfig } from './config.js';
import { isListening } from './environment.js';
import type { Executor } from './exec.js';
import { missingLocalConstants } from './local-constants.js';
import { siteKey } from './sites/site-actions.js';

/** Same lines as DMP_HOSTS_BEGIN and DMP_HOSTS_END in scripts/lib/hosts.sh. */
const HOSTS_BEGIN = '# BEGIN devmagic-panel (managed by the panel, edit sites there)';
const HOSTS_END = '# END devmagic-panel';

/** The primary domain of every line inside the panel's hosts block. */
export function hostsBlockDomains(hostsText: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const raw of hostsText.split('\n')) {
    const line = raw.trim();
    if (line === HOSTS_BEGIN) inside = true;
    else if (line === HOSTS_END) inside = false;
    else if (inside && line && !line.startsWith('#')) {
      const domain = line.split(/\s+/)[1]?.toLowerCase();
      if (domain && isLocalName(domain)) out.push(domain);
    }
  }
  return out;
}

export interface AuraContext {
  config: SystemConfig;
  exec: Executor;
  now?: () => number;
  /** The constants every local site should have, from Settings. */
  localConstants?: readonly LocalConstant[];
  /** A site's compatibility scans (by its key, like local.acme.com@learn), kept by the panel. */
  compatScans?: (key: string) => CompatScan[];
}

/**
 * Every problem the panel knows of: each site's issues, plus machine ones
 * (hosts lines left from removed sites, Mailpit down while sites need it).
 */
export async function readAura(ctx: AuraContext, sites: Site[]): Promise<AuraReport> {
  const items: AuraItem[] = sites.flatMap((site) => site.issues.map((issue) => ({ ...issue, domain: site.domain, ...(site.path ? { path: site.path } : {}) })));

  // A WordPress site without a local constant from Settings, or with another value: one fix each.
  for (const site of sites) {
    for (const c of missingLocalConstants(site, ctx.localConstants ?? [])) {
      const shown = typeof c.value === 'string' ? `'${c.value}'` : String(c.value);
      items.push({
        id: 'config.localConstant',
        status: 'warn',
        text: c.now === undefined ? `wp-config.php has no ${c.name}, which every local site should set to ${shown}` : `wp-config.php sets ${c.name} to ${typeof c.now === 'string' ? `'${c.now}'` : c.now}, not ${shown} as Settings asks`,
        fix: { action: 'site.setConstant', input: { domain: site.domain, ...(site.path ? { path: site.path } : {}), name: c.name, value: c.value }, label: `Set ${c.name}` },
        domain: site.domain,
        ...(site.path ? { path: site.path } : {}),
      });
    }
  }

  // The last check of the version a site runs found errors: no new scan, only what was kept.
  for (const site of sites) {
    const scan = site.php ? ctx.compatScans?.(siteKey(site.domain, site.path)).find((s) => s.version === site.php?.version) : undefined;
    if (!scan || scan.errors === 0) continue;
    const hit = scan.components.filter((c) => c.errors > 0).map((c) => c.title);
    items.push({
      id: 'php.compat',
      status: 'warn',
      text: `The last compatibility check against PHP ${scan.version}, which it runs, found ${scan.errors} error${scan.errors === 1 ? '' : 's'} in ${hit.join(', ')}`,
      hint: "Open the site's PHP tab for the files and lines: update that plugin or theme, or check again once it is fixed. The scanner can be wrong; its logs say what really fails.",
      domain: site.domain,
      ...(site.path ? { path: site.path } : {}),
    });
  }

  const hostsText = existsSync(ctx.config.HOSTS_FILE) ? readFileSync(ctx.config.HOSTS_FILE, 'utf8') : '';
  const known = new Set([ctx.config.PANEL_DOMAIN, ...sites.map((s) => s.domain)]);
  for (const domain of hostsBlockDomains(hostsText)) {
    if (known.has(domain)) continue;
    items.push({
      id: 'hosts.stale',
      status: 'warn',
      text: `/etc/hosts still points ${domain} here, but no site uses it`,
      fix: { action: 'hosts.remove', input: { domain }, label: 'Remove the line' },
    });
  }

  if (sites.some((s) => s.localMode?.enabled) && !(await isListening(ctx.exec, MAILPIT_SMTP.port))) {
    items.push({
      id: 'mailpit.down',
      status: 'warn',
      text: `Mailpit is not running on port ${MAILPIT_SMTP.port}: mail from sites in Local mode is dropped`,
      hint: 'Install or start Mailpit: https://mailpit.axllent.org/docs/install/',
    });
  }

  // Failures first, then warnings; the sort is stable, so sites keep their order.
  items.sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1));
  return { checkedAt: new Date(ctx.now?.() ?? Date.now()).toISOString(), items };
}

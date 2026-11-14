import { type FSWatcher, watch } from 'node:fs';
import { join } from 'node:path';
import type { HtaccessChange, HtaccessChanges } from '@devmagic-panel/shared';
import type { SystemConfig } from '../config.js';
import { scanHtaccess } from './htaccess.js';
import { chosenRules, readHtaccessReport, reportSums, ruleDiff, sameSums } from './htaccess-rules.js';
import { readSiteVhosts, type VhostInfo } from './vhost.js';

/**
 * Notices a change to the .htaccess files of the sites on nginx, so the panel
 * can say so while you work: nginx reads none of them, and the rules the
 * panel translated into the site's nginx file are applied only once you
 * review them. Never applies anything itself. The kernel's change
 * notifications (fs.watch) watch each site's folder and each folder with an
 * .htaccess; the panel also compares checksums when a site is read, for
 * changes made while it was not running.
 */

/** Where the Not now of a site's change is kept: its checksums then, as JSON. */
const DISMISSED = 'htaccess-dismissed:';

/** The checksums of a change to a site on nginx that you put off, from the panel's database. */
export function htaccessDismissed(store: { getMeta: (key: string) => string | undefined }, domain: string): Record<string, string> | undefined {
  const value = store.getMeta(`${DISMISSED}${domain}`);
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return undefined;
  }
}

/** site.dismissHtaccessChange: the change as it is now stays quiet until a file changes again. */
export function dismissHtaccessChange(store: { setMeta: (key: string, value: string) => void }, domain: string, sums: Record<string, string>): void {
  store.setMeta(`${DISMISSED}${domain}`, JSON.stringify(sums));
}

/** What a site's .htaccess files gave nginx when the panel last looked. */
interface Seen {
  sums: Record<string, string>;
  rules: string[];
  left: string[];
}

/** Bursts of writes (a plugin saving its settings) settle into one change. */
const SETTLE_MS = 2000;
/** The changes kept for the browser to ask about. */
const KEEP = 50;

export class HtaccessWatcher {
  private readonly watchers = new Map<string, FSWatcher[]>();
  private readonly seen = new Map<string, Seen>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private events: HtaccessChange[] = [];

  constructor(
    private readonly config: SystemConfig,
    private readonly now: () => number = Date.now,
    private readonly settleMs = SETTLE_MS,
  ) {}

  /** Watches the sites on nginx alone as they are now: new ones, new folders with an .htaccess, and none for sites gone from nginx. */
  refresh(): void {
    const sites = readSiteVhosts(this.config).filter((v): v is VhostInfo & { docroot: string } => v.server === 'nginx' && v.managed && Boolean(v.docroot));
    const domains = new Set(sites.map((v) => v.names[0] as string));
    for (const [domain, list] of this.watchers) {
      if (domains.has(domain)) continue;
      for (const w of list) w.close();
      this.watchers.delete(domain);
      this.seen.delete(domain);
    }
    for (const vhost of sites) {
      const domain = vhost.names[0] as string;
      for (const w of this.watchers.get(domain) ?? []) w.close();
      const folders = ['', ...scanHtaccess(vhost.docroot, true).folders];
      const list: FSWatcher[] = [];
      for (const folder of folders) {
        try {
          const w = watch(join(vhost.docroot, folder), { persistent: false }, (_event, name) => {
            if (name === null || String(name) === '.htaccess') this.soon(domain);
          });
          w.on('error', () => w.close());
          list.push(w);
        } catch {
          // A folder that went away between the scan and here.
        }
      }
      this.watchers.set(domain, list);
      if (!this.seen.has(domain)) this.seen.set(domain, this.look(vhost));
    }
  }

  /** What it watches now, for Sanctum: how many sites on nginx and folders, and when it last noticed a change. */
  state(): { sites: number; folders: number; lastChange?: string } {
    const folders = [...this.watchers.values()].reduce((n, list) => n + list.length, 0);
    const last = this.events.at(-1)?.at;
    return { sites: this.watchers.size, folders, ...(last ? { lastChange: last } : {}) };
  }

  /** The changes after since (an ISO time), oldest first, and the time to ask from next. */
  changes(since?: string): HtaccessChanges {
    const from = since ? Date.parse(since) : this.now();
    return { now: new Date(this.now()).toISOString(), changes: this.events.filter((e) => Date.parse(e.at) > from) };
  }

  close(): void {
    for (const list of this.watchers.values()) for (const w of list) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.watchers.clear();
    this.timers.clear();
  }

  private soon(domain: string): void {
    clearTimeout(this.timers.get(domain));
    const timer = setTimeout(() => {
      this.timers.delete(domain);
      this.check(domain);
    }, this.settleMs);
    timer.unref?.();
    this.timers.set(domain, timer);
  }

  /** Reads the site's .htaccess files again and records a change when they differ from the last look. */
  check(domain: string): HtaccessChange | undefined {
    const vhost = readSiteVhosts(this.config).find((v): v is VhostInfo & { docroot: string } => v.names[0] === domain && v.server === 'nginx' && Boolean(v.docroot));
    if (!vhost) return undefined;
    const before = this.seen.get(domain);
    const after = this.look(vhost);
    this.seen.set(domain, after);
    if (!before || sameSums(before.sums, after.sums)) return undefined;
    const report = readHtaccessReport(vhost.docroot, { rules: vhost.rules ?? [], sums: vhost.htaccessSums ?? {} }, this.now(), true);
    const { added, removed } = ruleDiff(report, vhost.rules ?? []);
    const rulesChanged = before.rules.join('\n') !== after.rules.join('\n');
    const newLeft = after.left.some((l) => !before.left.includes(l));
    const change: HtaccessChange = {
      domain,
      at: new Date(this.now()).toISOString(),
      kind: rulesChanged && added.length + removed.length > 0 ? 'rules' : newLeft ? 'manual' : 'quiet',
      added: added.length,
      removed: removed.length,
    };
    this.events = [...this.events, change].slice(-KEEP);
    return change;
  }

  private look(vhost: VhostInfo & { docroot: string }): Seen {
    const report = readHtaccessReport(vhost.docroot, undefined, this.now(), true);
    return {
      sums: reportSums(report),
      rules: chosenRules(report),
      left: report.rules.filter((r) => r.status === 'manual' || r.status === 'php').map((r) => `${r.file}\n${r.source}`),
    };
  }
}

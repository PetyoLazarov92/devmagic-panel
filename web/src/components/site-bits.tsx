import type { CheckStatus, Site, SiteInstall, SiteIssue } from '@devmagic-panel/shared';
import { INSTALL_HOW_LABELS, namespaceLabel, repoWeb } from '@devmagic-panel/shared';
import { CircleAlert, CircleX, LoaderCircle, Network, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { shortDate } from '@/lib/format';
import { runWithToast } from '@/lib/site-actions';
import { cn } from '@/lib/utils';

const dotTone: Record<CheckStatus, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  fail: 'bg-danger',
};
const dotLabel: Record<CheckStatus, string> = { ok: 'Healthy', warn: 'Needs attention', fail: 'Broken' };

export function StatusDot({ status, className }: { status: CheckStatus; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2.5 shrink-0', className)} title={dotLabel[status]}>
      {status === 'fail' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-40" />}
      <span className={cn('relative inline-flex size-2.5 rounded-full', dotTone[status])} />
      <span className="sr-only">{dotLabel[status]}</span>
    </span>
  );
}

export function IssueLine({ issue }: { issue: SiteIssue }) {
  const Icon = issue.status === 'fail' ? CircleX : CircleAlert;
  return (
    <p className={cn('flex items-start gap-1.5 text-xs', issue.status === 'fail' ? 'text-danger' : 'text-warning')}>
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="text-foreground/80">{issue.text}</span>
    </p>
  );
}

/** An issue with its one-click fix, or what to do by hand when there is none. */
export function IssueRow({ issue, domain, onFixed }: { issue: SiteIssue; domain?: string; onFixed?: () => void }) {
  const [busy, setBusy] = useState(false);
  const fix = issue.fix;

  async function runFix() {
    if (!fix) return;
    setBusy(true);
    const result = await runWithToast(fix.action, fix.input, domain ? `${fix.label} (${domain})` : fix.label);
    setBusy(false);
    if (result?.ok) onFixed?.();
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
      <div className="min-w-0 flex-1">
        <IssueLine issue={issue} />
        {issue.hint && <p className="mt-0.5 pl-5 text-xs text-muted-foreground">{issue.hint}</p>}
      </div>
      {fix && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void runFix()}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Wrench />}
          {fix.label}
        </Button>
      )}
    </div>
  );
}

/** "Multisite · 4 sites", with the network's type on hover. */
/** A network's type in WordPress's words. */
export const NETWORK_TYPE_LABEL = { subdirectory: 'Subdirectory', subdomain: 'Subdomain', mixed: 'Mixed subdirectory and subdomain' } as const;

export function NetworkBadge({ site, className }: { site: Site; className?: string }) {
  if (!site.network) return null;
  const count = site.network.sites.length;
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-primary', className)}
      title={`WordPress multisite, ${NETWORK_TYPE_LABEL[site.network.type].toLowerCase()} network`}
    >
      <Network className="size-3.5" />
      {count > 0 ? `Multisite · ${count} site${count === 1 ? '' : 's'}` : 'Multisite'}
    </span>
  );
}

/** "Twenty Two Words · 17 domains", leaving out what is unknown. */
export function siteSubtitle(site: Site): string {
  return [site.title, site.aliases.length > 0 ? `${site.aliases.length + 1} domains` : null].filter(Boolean).join(' · ');
}

/** How a site came here, in a few words: "From a repo, 12 Oct 2026, acme/shop" or "Made by hand". */
export function installLabel(install: SiteInstall | undefined): string {
  if (!install) return INSTALL_HOW_LABELS.hand;
  const repo = install.repo ? (repoWeb(install.repo)?.repoUrl.replace(/^https?:\/\/[^/]+\//, '') ?? install.repo) : null;
  return [
    INSTALL_HOW_LABELS[install.how],
    install.how === 'restore' && install.archivedAt ? `copy from ${shortDate(install.archivedAt)}` : null,
    install.at ? shortDate(install.at) : null,
    install.org && !repo ? namespaceLabel(install.org) : null,
    repo,
  ]
    .filter(Boolean)
    .join(', ');
}

export function coreLabel(site: Site): string {
  const { core } = site;
  if (core.kind === 'none') return 'Not WordPress';
  return `WordPress ${core.version ?? ''}${core.kind === 'wpcore' ? ' · shared core' : ' · own copy'}`.trim();
}

export function siteUrl(domain: string, path?: string): string {
  return `https://${domain}${path ? `${path}/` : ''}`;
}

/**
 * Opens a folder in VS Code through its URL handler. VS Code registers
 * vscode:// when installed, so the browser hands the folder to the editor on
 * the machine you browse from; the panel server runs nothing. windowId=_blank
 * opens a new window instead of reusing the last one.
 */
export function vscodeUrl(folder: string): string {
  return `vscode://file${encodeURI(folder)}?windowId=_blank`;
}

export function openInVSCode(folder: string): void {
  window.location.href = vscodeUrl(folder);
}

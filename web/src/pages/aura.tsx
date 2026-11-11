import type { CheckFix, AuraItem } from '@devmagic-panel/shared';
import { CircleCheck, LoaderCircle, Sparkles, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Tabs } from '@/components/ui/tabs';
import { IssueRow } from '@/components/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { VulnerabilityCheckCard } from '@/components/vulnerability-check';
import { api } from '@/lib/api';
import { Link, navigate } from '@/lib/router';
import { MachineChecks } from '@/pages/machine-checks';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { siteHref } from '@/lib/site-ref';
import { useAsync } from '@/lib/use-async';
import { CheckAgain, Notice, PageHeader } from '@/components/page';
import { CardSkeleton, Reading } from '@/components/skeletons';

const MACHINE = 'This machine';

/** One run per distinct fix: a cert reissue fixes every cert issue of its site. */
function distinctFixes(items: AuraItem[]): CheckFix[] {
  const seen = new Map<string, CheckFix>();
  for (const item of items) {
    if (item.fix) seen.set(`${item.fix.action}:${JSON.stringify(item.fix.input)}`, item.fix);
  }
  return [...seen.values()];
}

export type AuraTab = 'problems' | 'machine';

/**
 * Everything that needs fixing in one place: the problems of every site and
 * this machine, and on its second tab every check of the machine, passing or
 * not (once the Environment page).
 */
export function AuraPage({ tab = 'problems' }: { tab?: AuraTab }) {
  return (
    <div className="pt-4">
      <PageHeader
        title="Aura"
        intro="The health of your sites and this machine: every problem in one list, with a one-click fix where the panel can make one, and every check of the machine."
      />
      <Tabs
        className="mt-6"
        value={tab}
        onChange={(t) => navigate(t === 'machine' ? '/aura/machine' : '/aura')}
        items={[
          { value: 'problems', label: 'Problems' },
          { value: 'machine', label: 'Machine checks' },
        ]}
      />
      {tab === 'machine' ? <MachineChecks /> : <Problems />}
    </div>
  );
}

function Problems() {
  const { data: report, error, loading, reload } = useAsync(() => api.aura(), []);
  const [fixing, setFixing] = useState<{ done: number; total: number } | null>(null);

  const items = report?.items ?? [];
  const groups = new Map<string, AuraItem[]>();
  for (const item of items) {
    // A site under a path is its own group: local.spellbook.example/learn.
    const key = item.domain ? `${item.domain}${item.path ?? ''}` : MACHINE;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const fixes = distinctFixes(items);
  const failing = items.filter((i) => i.status === 'fail').length;

  async function fixAll() {
    setFixing({ done: 0, total: fixes.length });
    let failed = 0;
    for (const [index, fix] of fixes.entries()) {
      try {
        const result = await api.runAction(fix.action, fix.input);
        if (!result.ok) {
          failed++;
          toast({ tone: 'danger', title: `${fix.label} failed`, detail: lastLine(result.output) });
        }
      } catch (err) {
        failed++;
        toast({ tone: 'danger', title: `${fix.label} failed`, detail: (err as Error).message });
      }
      setFixing({ done: index + 1, total: fixes.length });
    }
    setFixing(null);
    if (failed === 0) toast({ tone: 'success', title: `${fixes.length} fix${fixes.length === 1 ? '' : 'es'} applied` });
    reload();
  }

  return (
    <div>
      <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
        {report && items.length === 0 ? (
          <Badge tone="success">Nothing to fix</Badge>
        ) : report ? (
          <>
            {failing > 0 && <Badge tone="danger">{failing} failing</Badge>}
            {items.length - failing > 0 && <Badge tone="warning">{items.length - failing === 1 ? '1 warning' : `${items.length - failing} warnings`}</Badge>}
            <span className="text-xs text-muted-foreground">{fixes.length} with a one-click fix</span>
          </>
        ) : null}
        {report && <span className="text-xs text-muted-foreground">Checked {new Date(report.checkedAt).toLocaleTimeString()}</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {fixes.length > 1 && (
            <Button size="sm" onClick={() => void fixAll()} disabled={fixing !== null || loading}>
              {fixing ? <LoaderCircle className="animate-spin" /> : <Wrench />}
              {fixing ? `Fixing ${fixing.done + 1} of ${fixing.total}` : `Fix all ${fixes.length}`}
            </Button>
          )}
          <CheckAgain size="sm" onClick={reload} loading={loading} disabled={fixing !== null} />
        </div>
      </div>

      {error && (
        <Notice className="mt-6">{error}</Notice>
      )}

      {!report && loading && (
        <div className="mt-6 grid gap-4" aria-busy="true">
          <Reading>Checking every site and this machine...</Reading>
          <CardSkeleton lines={3} />
          <CardSkeleton lines={4} />
          <CardSkeleton lines={2} />
        </div>
      )}

      {report && items.length === 0 && (
        <div className="mt-10 flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
          <CircleCheck className="size-8 text-success" />
          The aura is clear: every site and this machine look healthy.
        </div>
      )}

      <div className="mt-6 grid gap-4">
        {[...groups.entries()].map(([group, groupItems]) => (
          <Card key={group}>
            <CardHeader>
              <CardTitle>
                {group === MACHINE ? (
                  group
                ) : (
                  <Link href={siteHref({ domain: groupItems[0]?.domain ?? group, ...(groupItems[0]?.path ? { path: groupItems[0].path } : {}) })} className="hover:underline">{group}</Link>
                )}
              </CardTitle>
              <Sparkles className="size-4 text-muted-foreground" />
            </CardHeader>
            <div className="grid gap-3 px-5 py-4">
              {groupItems.map((item) => (
                <IssueRow key={`${item.id}:${item.text}`} issue={item} {...(item.domain ? { domain: item.domain } : {})} onFixed={reload} />
              ))}
            </div>
          </Card>
        ))}
        <VulnerabilityCheckCard onChecked={reload} />
      </div>
    </div>
  );
}

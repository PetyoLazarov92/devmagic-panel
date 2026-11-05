import type { CheckFix, AuraItem } from '@devmagic-panel/shared';
import { CircleCheck, LoaderCircle, RefreshCw, Sparkles, Wrench } from 'lucide-react';
import { useState } from 'react';
import { IssueRow } from '@/components/site-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { Link } from '@/lib/router';
import { lastLine } from '@/lib/site-actions';
import { toast } from '@/lib/toast';
import { siteHref } from '@/lib/site-ref';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';

const MACHINE = 'This machine';

/** One run per distinct fix: a cert reissue fixes every cert issue of its site. */
function distinctFixes(items: AuraItem[]): CheckFix[] {
  const seen = new Map<string, CheckFix>();
  for (const item of items) {
    if (item.fix) seen.set(`${item.fix.action}:${JSON.stringify(item.fix.input)}`, item.fix);
  }
  return [...seen.values()];
}

export function AuraPage() {
  const { data: report, error, loading, reload } = useAsync(() => api.aura(), []);
  const [fixing, setFixing] = useState<{ done: number; total: number } | null>(null);

  const items = report?.items ?? [];
  const groups = new Map<string, AuraItem[]>();
  for (const item of items) {
    // A site under a path is its own group: local.northwind.com/learn.
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
    <div className="pt-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h1 className="text-2xl font-semibold tracking-tight">Aura</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The health of your sites and this machine: every problem in one list, with a one-click fix where the panel can make one.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {fixes.length > 1 && (
            <Button onClick={() => void fixAll()} disabled={fixing !== null || loading}>
              {fixing ? <LoaderCircle className="animate-spin" /> : <Wrench />}
              {fixing ? `Fixing ${fixing.done + 1} of ${fixing.total}` : `Fix all ${fixes.length}`}
            </Button>
          )}
          <Button variant="outline" onClick={reload} disabled={loading || fixing !== null}>
            <RefreshCw className={cn(loading && 'animate-spin')} />
            Check again
          </Button>
        </div>
      </div>

      {report && (
        <div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
          {items.length === 0 ? (
            <Badge tone="success">Nothing to fix</Badge>
          ) : (
            <>
              {failing > 0 && <Badge tone="danger">{failing} failing</Badge>}
              {items.length - failing > 0 && <Badge tone="warning">{items.length - failing === 1 ? '1 warning' : `${items.length - failing} warnings`}</Badge>}
              <span className="text-xs text-muted-foreground">{fixes.length} with a one-click fix</span>
            </>
          )}
          <span className="text-xs text-muted-foreground">Checked {new Date(report.checkedAt).toLocaleTimeString()}</span>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-6 rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      {!report && loading && (
        <div className="mt-10 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" /> Checking every site...
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
      </div>
    </div>
  );
}

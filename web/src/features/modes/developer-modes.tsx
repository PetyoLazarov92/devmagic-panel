import type { ModesDeveloperView, SealedModeId } from '@devmagic-panel/shared';
import { Palette } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Fold } from '@/components/ui/fold';
import { Notice } from '@/components/ui/notice';
import { api } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { loadPreferences } from '@/lib/preferences';
import { refreshModes } from '@/lib/modes';
import { useAsync } from '@/lib/use-async';

/**
 * Developer options' card for the modes: each mode's paths with their rule
 * and progress, and the buttons to unlock, seal, fill a path for a test,
 * start a path or a mode over, and show the unlock dialog again. Only here
 * are the rules shown.
 */
export function DeveloperModes() {
  const { data, error, reload } = useAsync(() => api.modesDeveloper(), []);
  const [shown, setShown] = useState<ModesDeveloperView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const view = shown ?? data;

  async function run(work: () => Promise<ModesDeveloperView>) {
    setBusy(true);
    setFailed(null);
    try {
      setShown(await work());
      // The Modes page, the menu and the dialog see the change at once; sealing may have put the panel back on Classic.
      await Promise.all([refreshModes(true), loadPreferences()]);
    } catch (e) {
      setFailed((e as Error).message);
      reload();
    } finally {
      setBusy(false);
    }
  }
  const onMode = (mode: SealedModeId, what: 'unlock' | 'seal' | 'replay' | 'reset') => () => void run(() => api.modeDeveloper(mode, what));
  const onPath = (path: string, what: 'reset' | 'complete') => () => void run(() => api.modePath(path, what));

  return (
    <Card className="lg:col-span-2">
      <CardHeader title="Modes" description="The paths that unlock each mode, and their progress. The first path to reach its goal unlocks the mode." meta={<Palette className="size-4 text-muted-foreground" />} />
      <CardBody>
        {(error || failed) && <Notice size="inline">{failed ?? error}</Notice>}
        {view?.modes.map((m) => (
          <section key={m.id} className="grid gap-3" aria-label={`${m.title} mode`}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">{m.title}</h3>
              {m.unlocked ? (
                <Badge tone="success">Unlocked {shortDate(m.unlocked.at)} by {m.unlocked.byLabel}</Badge>
              ) : (
                <Badge>Sealed</Badge>
              )}
              {m.unlocked && !m.unlocked.seen && <Badge tone="primary">Dialog not shown yet</Badge>}
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="text-left text-2xs text-muted-foreground uppercase">
                  <tr>
                    <th className="px-3 py-2 font-medium">Path</th>
                    <th className="px-3 py-2 font-medium">Progress</th>
                    <th className="px-3 py-2 font-medium">Counting since</th>
                    <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {m.paths.map((p) => {
                    const won = m.unlocked?.by === p.id;
                    return (
                      <tr key={p.id} className="border-t">
                        <td className="px-3 py-2">{p.rule}</td>
                        <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                          {Math.min(p.progress, p.goal)} of {p.goal}
                          {won && <Badge tone="success" className="ml-2">won</Badge>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{shortDate(p.since)}</td>
                        <td className="px-3 py-2">
                          <span className="flex justify-end gap-1.5">
                            <Button size="sm" variant="soft" disabled={busy} onClick={onPath(p.id, 'reset')}>Reset</Button>
                            {!m.unlocked && <Button size="sm" variant="soft" disabled={busy} onClick={onPath(p.id, 'complete')}>Complete</Button>}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="border-t">
                    <td className="px-3 py-2">Type <span className="font-mono">{m.word}</span> in Ctrl+K</td>
                    <td className="px-3 py-2 text-muted-foreground">{m.unlocked?.by === 'word' ? 'spoken' : 'not spoken'}</td>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2" />
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2">
              {m.unlocked ? (
                <Button size="sm" variant="soft" disabled={busy} onClick={onMode(m.id, 'seal')}>Seal</Button>
              ) : (
                <Button size="sm" variant="soft" disabled={busy} onClick={onMode(m.id, 'unlock')}>Unlock</Button>
              )}
              {m.unlocked && <Button size="sm" variant="soft" disabled={busy} onClick={onMode(m.id, 'replay')}>Show the dialog again</Button>}
              <Button size="sm" variant="soft" disabled={busy} onClick={onMode(m.id, 'reset')}>Reset all paths</Button>
            </div>
          </section>
        ))}
        {view && (
          <Fold title="What the panel counts">
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              {view.counters.map((c) => (
                <li key={c.id} className="flex justify-between gap-3">
                  <span className="font-mono text-dense text-muted-foreground">{c.id}</span>
                  <span className="tabular-nums">{c.count}</span>
                </li>
              ))}
            </ul>
          </Fold>
        )}
      </CardBody>
    </Card>
  );
}

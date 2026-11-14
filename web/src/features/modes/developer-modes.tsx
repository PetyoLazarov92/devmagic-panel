import type { ModePuzzleQuestion, ModesDeveloperView, SealedModeId } from '@devmagic-panel/shared';
import { Palette } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Fold } from '@/components/ui/fold';
import { Notice } from '@/components/ui/notice';
import { api } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { loadPreferences } from '@/lib/preferences';
import { refreshModes, useModesView } from '@/lib/modes';
import { useAsync } from '@/lib/use-async';

/** Taps on the card's palette icon that open the puzzle; a pause of two seconds starts over. */
const TAPS = 7;

/**
 * Developer options' card for the modes. Locked, it lists each mode's name and
 * whether it is unlocked, nothing more. Seven taps on its palette icon ask a
 * puzzle; solved, the paths, their progress, the words and the buttons show
 * until Developer options are switched off. The panel itself keeps them back
 * until then.
 */
export function DeveloperModes() {
  const { data: state, reload } = useAsync(() => api.modesDeveloperState(), []);
  const [asking, setAsking] = useState(false);
  const taps = useRef({ count: 0, last: 0 });
  function tap() {
    const now = Date.now();
    const t = taps.current;
    t.count = now - t.last > 2000 ? 1 : t.count + 1;
    t.last = now;
    if (t.count >= TAPS) {
      t.count = 0;
      setAsking(true);
    }
  }
  if (state?.open) return <ModesSecrets />;
  return (
    <>
      <ModesLocked onTap={tap} />
      <ModesPuzzle
        open={asking}
        onClose={() => setAsking(false)}
        onSolved={() => {
          setAsking(false);
          reload();
        }}
      />
    </>
  );
}

/** The locked card: each mode's name and status; its palette icon counts the taps. */
function ModesLocked({ onTap }: { onTap: () => void }) {
  const view = useModesView();
  useEffect(() => void refreshModes(true), []);
  const modes = view?.modes.filter((m) => m.id !== 'classic') ?? [];
  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="Modes"
        description="Each mode and whether it is unlocked."
        meta={
          // Looks like the icon it always was; seven taps on it ask the puzzle.
          <IconButton icon={Palette} label="Modes" size="icon-sm" onClick={onTap} className="cursor-default text-muted-foreground select-none hover:bg-transparent hover:text-muted-foreground" />
        }
      />
      <CardBody>
        <ul className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {modes.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3">
              <span className="font-medium">{m.title}</span>
              {m.unlocked ? <Badge tone="success">Unlocked</Badge> : <Badge>Sealed</Badge>}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/** One question at a time from the panel; a wrong answer brings a new one. */
function ModesPuzzle({ open, onClose, onSolved }: { open: boolean; onClose: () => void; onSolved: () => void }) {
  const [question, setQuestion] = useState<ModePuzzleQuestion | null>(null);
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setWrong(false);
    setFailed(null);
    setQuestion(null);
    api.modesPuzzle().then(setQuestion, (e: Error) => setFailed(e.message));
  }, [open]);
  async function answer(choice: number) {
    if (!question) return;
    setBusy(true);
    setFailed(null);
    try {
      const result = await api.modesPuzzleAnswer(question.id, choice);
      if (result.solved) onSolved();
      else {
        setWrong(true);
        setQuestion(result.next);
      }
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="A question first" description="Answer it to see how each mode opens.">
      <div className="grid gap-4">
        {failed && <Notice size="inline">{failed}</Notice>}
        {wrong && <Notice size="inline" tone="warning">Not that one. Here is another question.</Notice>}
        {question && (
          <>
            <p className="text-base font-medium">{question.question}</p>
            <div className="grid grid-cols-2 gap-2">
              {question.options.map((o, i) => (
                <Button key={`${question.id}-${o}`} variant="outline" disabled={busy} onClick={() => void answer(i)}>
                  {o}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Opened: each mode's paths with their rule and progress, its word, and the buttons to unlock, seal, fill or start over. */
function ModesSecrets() {
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
  const onMode = (mode: SealedModeId, what: 'unlock' | 'seal' | 'reset') => () => void run(() => api.modeDeveloper(mode, what));
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

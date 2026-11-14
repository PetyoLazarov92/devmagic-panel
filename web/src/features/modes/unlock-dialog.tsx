import { EFFECTS_ON, MODE_INFO, type SealedModeId } from '@devmagic-panel/shared';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ModeThumb } from '@/features/modes/mode-thumb';
import { api } from '@/lib/api';
import { setModesView, useModesView, useReducedMotion } from '@/lib/modes';
import { savePreferences, usePreferences } from '@/lib/preferences';
import { toast } from '@/lib/toast';

/** Whether now is a good moment: no other dialog open, no form with unsaved changes. */
function quietMoment(): boolean {
  return !document.querySelector('dialog[open]') && !document.querySelector('[role="region"][aria-label="Unsaved changes"]');
}

/**
 * Once per unlock, across every browser: you unlocked a new mode, with Switch
 * now and Later. It waits for a quiet moment: never over another dialog or a
 * form with unsaved changes.
 */
export function UnlockDialog({ path }: { path: string }) {
  const view = useModesView();
  const prefs = usePreferences();
  const reduced = useReducedMotion();
  const fresh = view?.fresh[0];
  const [showing, setShowing] = useState<SealedModeId | null>(null);

  useEffect(() => {
    if (!fresh || showing) return;
    // A moment after the page changed or the unlock arrived, then every few seconds until it is quiet.
    let timer = window.setTimeout(function check() {
      if (quietMoment()) setShowing(fresh);
      else timer = window.setTimeout(check, 3000);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [fresh, showing, path]);

  if (!showing) return null;
  const mode = view?.modes.find((m) => m.id === showing);
  const title = MODE_INFO[showing].title;

  function close() {
    const mode = showing;
    setShowing(null);
    if (mode) void api.modeSeen(mode).then(setModesView, () => undefined);
  }

  function switchNow() {
    if (!showing) return;
    savePreferences({ mode: showing, effects: { ...prefs.effects, [showing]: EFFECTS_ON } });
    toast({ tone: 'success', title: `${title} mode is on`, detail: reduced ? 'Your system asks for reduced motion, so its effects stay off.' : 'Effects are on. Turn any of them off on the Modes page.' });
    close();
  }

  return (
    <Dialog
      open
      onClose={close}
      title={`You unlocked ${title} mode`}
      size="lg"
      footer={
        <>
          <Button variant="soft" onClick={close}>Later</Button>
          <Button data-autofocus onClick={switchNow}>Switch to {title}</Button>
        </>
      }
    >
      {/* Wide: the picture of the mode beside what earned it; stacked on a phone. */}
      <div className="grid items-center gap-5 text-sm sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <ModeThumb mode={showing} reveal={!reduced} />
        <div className="grid gap-3">
          {mode?.unlockLine && <p className="text-base font-medium">{mode.unlockLine}</p>}
          <p className="text-muted-foreground">{MODE_INFO[showing].description}</p>
          <p className="text-xs text-muted-foreground">You can switch back any time on the Modes page.</p>
        </div>
      </div>
    </Dialog>
  );
}

import { EFFECTS_OFF, EFFECTS_ON, MODE_EFFECT_INFO, MODE_EFFECTS, type ModeEffect, type ModeId, type ModeView } from '@devmagic-panel/shared';
import { Eye } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Notice, PageHeader } from '@/components/layout/page';
import { CardsSkeleton } from '@/components/layout/skeletons';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { ModeThumb } from '@/features/modes/mode-thumb';
import { refreshModes, setPreviewMode, useModesView, usePreviewMode, useReducedMotion } from '@/lib/modes';
import { savePreferences, usePreferences } from '@/lib/preferences';
import { cn } from '@/lib/utils';

/** How long Preview shows a mode before the page goes back to the one you use. */
const PREVIEW_MS = 20_000;
/** An unlock is new for a week, unless you use the mode before. */
const NEW_FOR_MS = 7 * 24 * 3600_000;

/**
 * How the panel looks, on top of light and dark: the mode you use in one wide
 * card with its effects, every other mode below. A sealed mode shows a riddle
 * per path that opens it, never the rule.
 */
export function ModesPage() {
  const view = useModesView();
  const prefs = usePreferences();
  const previewing = usePreviewMode();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void refreshModes(true).finally(() => setLoaded(true));
  }, []);

  // A preview ends after a while, and when you leave the page.
  const timer = useRef(0);
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    setPreviewMode(null);
  }, []);
  function preview(mode: ModeId) {
    window.clearTimeout(timer.current);
    setPreviewMode(mode);
    timer.current = window.setTimeout(() => setPreviewMode(null), PREVIEW_MS);
  }
  function activate(mode: ModeId) {
    window.clearTimeout(timer.current);
    setPreviewMode(null);
    // A mode used for the first time comes with its effects on; they are each a switch away.
    savePreferences(mode === 'classic' || prefs.effects[mode] ? { mode } : { mode, effects: { ...prefs.effects, [mode]: EFFECTS_ON } });
  }

  const active = view?.modes.find((m) => m.id === prefs.mode) ?? view?.modes[0];
  const others = view?.modes.filter((m) => m.id !== active?.id) ?? [];
  const sealedCount = others.filter((m) => !m.unlocked).length;

  return (
    <div className="pt-4">
      <PageHeader title="Modes" intro="How the panel looks, on top of light and dark. Some modes are sealed: they open as you use the panel." />
      {previewing && (
        <Notice
          tone="info"
          className="mt-6"
          action={
            <>
              <Button size="sm" onClick={() => activate(previewing)}>Activate</Button>
              <Button size="sm" variant="soft" onClick={() => setPreviewMode(null)}>End preview</Button>
            </>
          }
        >
          Previewing {view?.modes.find((m) => m.id === previewing)?.title ?? previewing} on this page for a few seconds.
        </Notice>
      )}
      {!view && !loaded && <CardsSkeleton className="mt-6" reading="Reading the modes..." cards={[5, 3]} />}
      {!view && loaded && <Notice className="mt-6">The modes could not be read. Try again in a moment.</Notice>}
      {view && active && (
        <>
          <ActiveMode mode={active} />
          {others.length > 0 && (
            <section className="mt-8" aria-labelledby="more-modes">
              <h2 id="more-modes" className="text-sm font-semibold">More modes{sealedCount > 0 ? <span className="font-normal text-muted-foreground"> · {sealedCount === 1 ? '1 sealed' : `${sealedCount} sealed`}</span> : null}</h2>
              <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {others.map((m) => (m.unlocked ? <UnlockedMode key={m.id} mode={m} onActivate={() => activate(m.id)} onPreview={() => preview(m.id)} /> : <SealedMode key={m.id} mode={m} />))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ActiveMode({ mode }: { mode: ModeView }) {
  const prefs = usePreferences();
  const reduced = useReducedMotion();
  const classic = mode.id === 'classic';
  const effects = mode.id === 'classic' ? EFFECTS_OFF : (prefs.effects[mode.id] ?? EFFECTS_OFF);
  function set(effect: ModeEffect, on: boolean) {
    if (classic) return;
    savePreferences({ effects: { ...prefs.effects, [mode.id]: { ...effects, [effect]: on } } });
  }
  return (
    <Card className="mt-6 grid gap-6 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <ModeThumb mode={mode.id} />
      <div className="grid content-start gap-4">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {mode.title}
            <Badge tone="primary">Active</Badge>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{mode.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="w-24 text-muted-foreground">Theme</span>
          <ThemeToggle />
        </div>
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">Effects</p>
          {MODE_EFFECTS.map((effect) => (
            <div key={effect} className={cn('flex items-start gap-3', (classic || reduced) && 'opacity-60')}>
              <Switch checked={!reduced && effects[effect]} disabled={classic || reduced} label={MODE_EFFECT_INFO[effect].label} onChange={(on) => set(effect, on)} />
              <div className="min-w-0">
                <p className="text-sm font-medium">{MODE_EFFECT_INFO[effect].label}</p>
                <p className="text-xs text-muted-foreground">{MODE_EFFECT_INFO[effect].what}</p>
              </div>
            </div>
          ))}
          {classic && <p className="text-xs text-muted-foreground">Effects come with the other modes.</p>}
          {!classic && reduced && <p className="text-xs text-muted-foreground">Your system asks for reduced motion, so the effects stay off. Your switches are kept for when it doesn't.</p>}
        </div>
      </div>
    </Card>
  );
}

function UnlockedMode({ mode, onActivate, onPreview }: { mode: ModeView; onActivate: () => void; onPreview: () => void }) {
  const fresh = mode.unlockedAt !== undefined && Date.now() - Date.parse(mode.unlockedAt) < NEW_FOR_MS;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <ModeThumb mode={mode.id} />
      <div>
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {mode.title}
          {fresh && <Badge tone="success">New</Badge>}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{mode.description}</p>
      </div>
      <div className="mt-auto flex flex-wrap gap-2">
        <Button size="sm" onClick={onActivate}>Activate</Button>
        {mode.id !== 'classic' && (
          <Button size="sm" variant="soft" onClick={onPreview}>
            <Eye />
            Preview
          </Button>
        )}
      </div>
    </Card>
  );
}

function SealedMode({ mode }: { mode: ModeView }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <ModeThumb mode={mode.id} sealed />
      <div>
        <h3 className="text-sm font-semibold">Sealed</h3>
        <ul className="mt-1.5 grid gap-1.5">
          {mode.riddles?.map((r) => (
            <li key={r.text} className="text-xs italic">
              “{r.text}”
              {r.weakening && <Badge tone="success" className="ml-1.5 not-italic">The seal is weakening</Badge>}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

import { EFFECTS_OFF, EFFECTS_ON, MODE_EFFECT_INFO, MODE_EFFECT_LABEL, MODE_EFFECTS, type ModeEffect, type ModeId, type ModeView } from '@devmagic-panel/shared';
import { Eye } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
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

/** What the effects are, said for any mode: on Classic, which has none. */
const ANY_EFFECT: Record<ModeEffect, string> = {
  pointer: 'Something that follows your cursor and answers a click.',
  elements: "Life on the page's own parts: a broken site, a healthy one, what runs.",
  background: 'Movement behind the pages.',
};

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
  const ownNames = mode.id !== 'classic' && prefs.modeNames?.[mode.id] !== false;
  function setNames(on: boolean) {
    if (mode.id === 'classic') return;
    savePreferences({ modeNames: { ...prefs.modeNames, [mode.id]: on } });
  }
  return (
    <Card className="mt-6 grid gap-6 p-5 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      {/* The mode itself: its picture, name and theme. */}
      <div className="grid content-start gap-4">
        <ModeThumb mode={mode.id} />
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {mode.title}
            <Badge tone="primary">Active</Badge>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{mode.description}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">Theme</span>
          <ThemeToggle />
        </div>
      </div>
      {/* Its switches, one list per group, each switch at the right edge of its row. */}
      <div className="grid content-start gap-5">
        <SettingGroup title="Effects" note={classic ? 'Effects come with the other modes.' : reduced ? "Your system asks for reduced motion, so the effects stay off. Your switches are kept for when it doesn't." : undefined}>
          {MODE_EFFECTS.map((effect) => (
            <SettingRow
              key={effect}
              label={MODE_EFFECT_LABEL[effect]}
              detail={mode.id === 'classic' ? ANY_EFFECT[effect] : MODE_EFFECT_INFO[mode.id][effect]}
              checked={!reduced && effects[effect]}
              disabled={classic || reduced}
              onChange={(on) => set(effect, on)}
            />
          ))}
        </SettingGroup>
        <SettingGroup title="Words">
          <SettingRow
            label="Own names"
            detail={classic ? 'The other modes name pages and a few lines their own way.' : `Pages and a few lines in ${mode.title}'s own words. Off keeps the panel's usual names and texts, with the look and the effects as they are.`}
            checked={ownNames}
            disabled={classic}
            onChange={setNames}
          />
        </SettingGroup>
      </div>
    </Card>
  );
}

/** A group of the active mode's switches: a small heading and its rows in one framed list, with a note under it. */
function SettingGroup({ title, note, children }: { title: string; note?: string | undefined; children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      <div className="divide-y rounded-lg border bg-card">{children}</div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}

/** One switch of the active mode: what it is and what it does on the left, the switch at the right edge, centered on the row. */
function SettingRow({ label, detail, checked, disabled, onChange }: { label: string; detail: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 px-4 py-3', disabled && 'opacity-60')}>
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      </div>
      <Switch checked={checked} disabled={disabled} label={label} onChange={onChange} />
    </div>
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

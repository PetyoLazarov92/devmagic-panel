import type { NewSiteSource } from '@devmagic-panel/shared';
import { Check, FolderGit2, Globe, Sparkles, Wand2 } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// ── Start ────────────────────────────────────────────────────

// Only colours and the shadow animate: the Claude card swaps its 1px border for a 2px one and a pixel of padding,
// and animating both would move its content by a pixel on the way.
export const START_CARD = 'flex h-full w-full flex-col items-start gap-3 rounded-xl p-5 text-left transition-[color,background-color,border-color,box-shadow]';
/** The picked card: a light tint and a 2px edge (its border and a 1px ring), so the choice never rests on the icon alone. */
export const START_PICKED = 'border-primary bg-primary/6 shadow-[0_0_0_1px_var(--primary)]';

/** The radio mark in every start card's top right corner. */
export function RadioMark({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card',
        disabled && 'opacity-50',
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

/** A start card's icon, badge, radio mark, title and text; the text is kept to three lines at four cards a row. */
export function StartCardBody({ icon, active, badge, title, text, muted }: { icon: ReactNode; active: boolean; badge?: ReactNode; title: string; text: string; muted?: boolean }) {
  return (
    <>
      <span className="flex w-full items-start gap-2">
        <span className={cn('inline-flex size-9 items-center justify-center rounded-lg [&_svg]:size-4.5', active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{icon}</span>
        <span className="ml-auto flex items-center gap-2">
          {badge}
          <RadioMark checked={active} disabled={muted === true} />
        </span>
      </span>
      <span>
        <span className={cn('block font-medium', muted && 'text-muted-foreground')}>{title}</span>
        <span className="mt-1 block text-sm text-muted-foreground">{text}</span>
      </span>
    </>
  );
}

export function StartStep({ value, claude, onChange }: { value: NewSiteSource; claude: boolean; onChange: (v: NewSiteSource) => void }) {
  const options: Array<{ value: NewSiteSource; title: string; text: string; icon: ReactNode; recommended?: boolean }> = [
    {
      value: 'repo',
      title: 'From a project',
      text: 'Pick its repos from your GitHub organizations and GitLab groups, or paste any git URL, then bring its database.',
      icon: <FolderGit2 />,
      recommended: true,
    },
    { value: 'wordpress', title: 'Fresh WordPress', text: 'A clean install, linked to a shared core or with its own copy.', icon: <Wand2 /> },
    { value: 'empty', title: 'Empty site', text: 'Folder, certificate, vhost and hosts line only. For anything that is not WordPress.', icon: <Globe /> },
  ];
  const refs = useRef(new Map<NewSiteSource, HTMLButtonElement>());
  // One card is in the tab order, the picked one; arrow keys move the choice, as in any radio group.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const move = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!move || !(e.target instanceof HTMLElement) || e.target.getAttribute('role') !== 'radio') return;
    e.preventDefault();
    const order = options.map((o) => o.value);
    const next = order[(Math.max(0, order.indexOf(value)) + move + order.length) % order.length] as NewSiteSource;
    onChange(next);
    refs.current.get(next)?.focus();
  }
  return (
    <div role="radiogroup" aria-label="What are you setting up?" onKeyDown={onKeyDown} className="grid gap-3 md:grid-cols-3">
      {options.map((o) => {
        const on = value === o.value;
        const ai = o.value === 'repo' && claude;
        return (
          <button
            key={o.value}
            ref={(el) => void (el ? refs.current.set(o.value, el) : refs.current.delete(o.value))}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(START_CARD, ai ? 'ai-border p-[19px] hover:shadow-md' : 'border bg-card hover:border-primary/50', on && (ai ? 'ai-picked' : START_PICKED))}
          >
            <StartCardBody
              icon={o.icon}
              active={on}
              badge={
                <span className="flex gap-1.5">
                  {o.recommended && <Badge tone="success">Most used</Badge>}
                  {ai && <Badge tone="primary"><Sparkles className="size-3" />Claude</Badge>}
                </span>
              }
              title={o.title}
              text={ai ? `${o.text} Claude can read the repo and its links for you.` : o.text}
            />
          </button>
        );
      })}
    </div>
  );
}

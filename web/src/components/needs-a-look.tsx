import { cn } from '@/lib/utils';

export interface Look {
  key: string;
  tone: 'danger' | 'warning';
  text: string;
  /** Where it is: the id of the card it scrolls to. */
  card: string;
  /** Before scrolling, like picking the list's filter that shows it. */
  before?: () => void;
}

/**
 * What needs a look on a long tool page, above its cards: one link per card
 * that found something, worst first, which scrolls to that card. Nothing at
 * all when everything is fine, so a healthy page stays quiet.
 */
export function NeedsALook({ items }: { items: Look[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning/6 px-4 py-3 text-sm">
      <span className="font-medium">{items.length === 1 ? '1 thing needs a look' : `${items.length} things need a look`}</span>
      {items.map((f) => (
        <button
          key={f.key}
          type="button"
          onClick={() => {
            f.before?.();
            window.setTimeout(() => document.getElementById(f.card)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
          }}
          className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium hover:underline', f.tone === 'danger' ? 'bg-danger/12 text-danger' : 'bg-warning/15 text-warning')}
        >
          {f.text}
        </button>
      ))}
    </div>
  );
}

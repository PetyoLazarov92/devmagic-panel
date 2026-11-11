import { ChevronDown } from 'lucide-react';
import { Fragment, type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { CountBadge } from '@/components/ui/badge';
import { Menu } from '@/components/ui/menu';
import { fittingTabs } from '@/lib/tabs-fit';
import { cn } from '@/lib/utils';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
  /** Colors the count, for problems such as failing checks. */
  tone?: 'warning' | 'danger';
  /** Draws a thin line before the tab, between groups of related tabs. */
  startsGroup?: boolean;
}

interface Props<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** sm: the second level, the views inside a tab (a database's Tables, SQL). */
  size?: 'default' | 'sm';
  /** What the tabs choose between, for screen readers ("Scanned versions"). */
  label?: string;
  className?: string;
}

const labelText = (item: TabItem<string>): string => (typeof item.label === 'string' ? item.label : item.value) + (item.count !== undefined ? ` (${item.count})` : '');

/**
 * Underline tabs with arrow-key navigation (WAI-ARIA tabs pattern). Tabs
 * that do not fit the row go under More, a menu at its end, instead of a
 * row that scrolls sideways.
 */
export function Tabs<T extends string>({ items, value, onChange, size = 'default', label, className }: Props<T>) {
  const pad = size === 'sm' ? 'px-2.5 py-1.5 text-dense' : 'px-3 py-2 text-sm';
  const id = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const selected = items.findIndex((item) => item.value === value);
  const [shown, setShown] = useState<number[] | null>(null);

  useLayoutEffect(() => {
    const el = row.current;
    const ruler = measure.current;
    if (!el || !ruler) return;
    const fit = () => {
      // Each tab's width with the group line before it, from the hidden copy that holds them all.
      const widths = [...ruler.children].map((child) => (child as HTMLElement).getBoundingClientRect().width + 4);
      setShown(fittingTabs(widths, el.clientWidth, selected));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [items.map((i) => `${i.value}:${i.count ?? ''}`).join(','), selected]);

  const visible = (shown ?? items.map((_, i) => i)).filter((i) => i < items.length).sort((a, b) => a - b);
  const hidden = items.map((_, i) => i).filter((i) => !visible.includes(i));

  function onKey(event: KeyboardEvent, at: number) {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = visible[(at + delta + visible.length) % visible.length] as number;
    const item = items[next];
    if (!item) return;
    onChange(item.value);
    refs.current[next]?.focus();
  }

  const tab = (item: TabItem<T>, i: number, at: number) => {
    const isSelected = item.value === value;
    return (
      <Fragment key={item.value}>
        {item.startsGroup && at > 0 && <span aria-hidden className="my-2 w-px shrink-0 bg-border" />}
        <button
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={`${id}-${item.value}`}
          role="tab"
          type="button"
          aria-selected={isSelected}
          tabIndex={isSelected ? 0 : -1}
          onClick={() => onChange(item.value)}
          onKeyDown={(e) => onKey(e, at)}
          className={cn(
            '-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 whitespace-nowrap transition-colors',
            pad,
            isSelected ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {item.label}
          {item.count !== undefined && <Count item={item} />}
        </button>
      </Fragment>
    );
  };

  const hiddenCount = hidden.reduce((n, i) => n + (items[i]?.count ?? 0), 0);
  const hiddenTone = hidden.some((i) => items[i]?.tone === 'danger') ? 'danger' : hidden.some((i) => items[i]?.tone === 'warning') ? 'warning' : undefined;
  return (
    <div className={cn('relative', className)}>
      <div ref={row} role="tablist" aria-label={label} className="flex gap-1 overflow-hidden border-b">
        {visible.map((i, at) => tab(items[i] as TabItem<T>, i, at))}
        {hidden.length > 0 && (
          <div className="ml-auto flex shrink-0 items-center">
            <Menu
              label={`More tabs: ${hidden.map((i) => labelText(items[i] as TabItem<string>)).join(', ')}`}
              items={hidden.map((i) => ({ label: labelText(items[i] as TabItem<string>), onSelect: () => onChange((items[i] as TabItem<T>).value) }))}
              trigger={
                <>
                  More
                  {hiddenCount > 0 && <Count item={{ value: 'more', label: '', count: hiddenCount, ...(hiddenTone ? { tone: hiddenTone } : {}) }} />}
                  <ChevronDown className="size-3.5" />
                </>
              }
              triggerClassName={cn('-mb-px rounded-none border-b-2 border-transparent whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground', pad)}
            />
          </div>
        )}
      </div>
      {/* Every tab, out of sight, to measure what fits. */}
      <div aria-hidden className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden">
        <div ref={measure} className="flex w-max gap-1 whitespace-nowrap">
          {items.map((item) => (
            <span key={item.value} className={cn('inline-flex items-center gap-2 font-medium', pad)}>
              {item.startsGroup && <span className="mr-1 w-px" />}
              {item.label}
              {item.count !== undefined && <Count item={item} />}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Count({ item }: { item: TabItem<string> }) {
  return <CountBadge count={item.count ?? 0} tone={item.tone ?? 'neutral'} />;
}

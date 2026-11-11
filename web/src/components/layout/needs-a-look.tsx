import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { scrollToCard } from '@/lib/scroll-to';

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
    <Notice tone="warning">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{items.length === 1 ? '1 thing needs a look' : `${items.length} things need a look`}</span>
        {items.map((f) => (
          <Button
            key={f.key}
            variant="ghost"
            size="xs"
            onClick={() => {
              f.before?.();
              // After the filter it picks has drawn the list.
              window.setTimeout(() => scrollToCard(f.card), 0);
            }}
            className="group h-auto rounded-full p-0 hover:bg-transparent"
          >
            <Badge tone={f.tone} className="px-2.5 group-hover:underline">{f.text}</Badge>
          </Button>
        ))}
      </div>
    </Notice>
  );
}

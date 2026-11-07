import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

/** How many rows a long list shows first, and how many each Show more adds. */
export const LIST_STEP = 21;

const number = (n: number) => n.toLocaleString('en-US');

/**
 * The first rows of a long list, more on each Show more. For a list already
 * in the browser and ranked, like the heaviest queries first: the top is
 * what matters, so it grows in place instead of turning pages. Pass `reset`
 * (a search, a filter) to start short again when it changes.
 */
export function useShowMore<T>(items: readonly T[], { step = LIST_STEP, reset }: { step?: number; reset?: unknown } = {}) {
  const [state, setState] = useState({ count: step, reset });
  const count = Object.is(state.reset, reset) ? state.count : step;
  const set = (n: number) => setState({ count: n, reset });
  return {
    shown: items.slice(0, count),
    footer: { total: items.length, count, step, setCount: set },
  };
}

/**
 * The line under a list cut by useShowMore: how many show, Show more, Show
 * all and Show fewer. Nothing while the list fits.
 */
export function ShowMore({ total, count, step, setCount, noun = 'rows' }: ReturnType<typeof useShowMore>['footer'] & { noun?: string }) {
  if (total <= step) return null;
  const link = 'flex items-center gap-1 font-medium text-primary hover:underline';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-5 py-2 text-xs">
      <span className="text-muted-foreground tabular-nums">
        {number(Math.min(count, total))} of {number(total)} {noun}
      </span>
      {count < total ? (
        <>
          <button type="button" className={link} onClick={() => setCount(count + step)}>
            <ChevronDown className="size-3.5" />Show {number(Math.min(step, total - count))} more
          </button>
          <button type="button" className={link} onClick={() => setCount(total)}>
            Show all {number(total)}
          </button>
        </>
      ) : (
        <button type="button" className={link} onClick={() => setCount(step)}>
          <ChevronUp className="size-3.5" />Show fewer
        </button>
      )}
    </div>
  );
}

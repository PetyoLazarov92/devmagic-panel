import type { FileDiff } from '@devmagic-panel/shared';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

/** The lines of a unified diff that only say which files it compares. */
const HEAD = /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename (from|to) )/;

/**
 * A unified diff as git and diff write it: taken lines red, added lines
 * green, with the sign in front of each, so the colour is never the only
 * thing that tells them apart.
 */
export function DiffView({ diff, label, same }: { diff: FileDiff; label: string; same: string }) {
  const lines = useMemo(() => {
    const all = diff.diff.split('\n');
    if (all.at(-1) === '') all.pop();
    return all;
  }, [diff.diff]);
  if (lines.length === 0) return <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground" role="status">{same}</p>;
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++ ')).length;
  const taken = lines.filter((l) => l.startsWith('-') && !l.startsWith('--- ')).length;
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <p className="border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
        {label}: <span className="font-medium text-success">{added} added</span>, <span className="font-medium text-danger">{taken} taken out</span>
        {diff.cut ? '. Too long to show whole: this is its start.' : '.'}
      </p>
      <div role="region" aria-label={label} tabIndex={0} className="max-h-[60vh] overflow-auto py-2 font-mono text-xs leading-5">
        <div className="w-max min-w-full">
          {lines.map((line, i) => {
            const head = HEAD.test(line);
            const kind = head ? 'head' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'take' : 'same';
            return (
              <div
                key={i}
                className={cn(
                  'px-4 whitespace-pre',
                  kind === 'head' && 'text-muted-foreground',
                  kind === 'hunk' && 'mt-1 bg-muted/60 text-muted-foreground',
                  kind === 'add' && 'bg-success/12',
                  kind === 'take' && 'bg-danger/10',
                )}
              >
                {line || ' '}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

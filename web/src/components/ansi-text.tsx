import { ansiRuns } from '@/lib/ansi';
import { cn } from '@/lib/utils';

/** The 8 terminal colors, readable on the light and the dark theme. */
const COLORS: Record<number, string> = {
  30: 'text-foreground',
  31: 'text-red-600 dark:text-red-400',
  32: 'text-green-700 dark:text-green-400',
  33: 'text-amber-700 dark:text-amber-400',
  34: 'text-blue-600 dark:text-blue-400',
  35: 'text-fuchsia-600 dark:text-fuchsia-400',
  36: 'text-cyan-700 dark:text-cyan-400',
  37: 'text-muted-foreground',
};

/** Command output with its terminal colors shown, not their codes. */
export function AnsiText({ text }: { text: string }) {
  return (
    <>
      {ansiRuns(text).map((r, i) =>
        r.color || r.rgb || r.bold || r.dim ? (
          <span key={i} className={cn(r.color && COLORS[r.color], r.bold && 'font-semibold', r.dim && 'opacity-70')} style={r.rgb ? { color: r.rgb } : undefined}>
            {r.text}
          </span>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

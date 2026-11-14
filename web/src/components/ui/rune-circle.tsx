import { cn } from '@/lib/utils';

/**
 * Wizard mode's turning icon, in place of the spinner: a ring, a dashed ring,
 * a triangle and a star, turning as one while something runs, as the spinner
 * does. Turning the whole icon lets the browser do it without drawing it again.
 */
export function RuneCircle({ className, progress }: { className?: string; progress?: number }) {
  const r = 28;
  const length = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 64 64" className={cn('rune-circle', progress === undefined && 'rune-turning', className)} aria-hidden>
      <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="4" />
      {progress === undefined ? (
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${length * 0.28} ${length}`} />
      ) : (
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeDasharray={length} strokeDashoffset={length * (1 - Math.min(1, Math.max(0, progress)))} transform="rotate(-90 32 32)" />
      )}
      <circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 6" />
      <path d="M32 16 45.9 40H18.1Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeOpacity=".7" />
      <path d="M32 24 34 30 40 32 34 34 32 40 30 34 24 32 30 30Z" fill="currentColor" />
    </svg>
  );
}

/**
 * Circuit mode's turning icon: a ring of segments with a brighter arc and a
 * square at its center, turning as one while something runs.
 */
export function SegmentRing({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('rune-turning', className)} aria-hidden>
      <circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="5" strokeDasharray="10 4.2" />
      <circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" strokeWidth="5" strokeDasharray="10 4.2 10 4.2 10 200" />
      <circle cx="32" cy="32" r="17" fill="none" stroke="currentColor" strokeOpacity=".55" strokeWidth="2" strokeDasharray="2 4" />
      <rect x="27" y="27" width="10" height="10" fill="currentColor" />
    </svg>
  );
}

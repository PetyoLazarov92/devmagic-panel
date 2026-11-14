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

/**
 * Forge's turning icon: a toothed gear with a hub, turning as one while
 * something runs.
 */
export function Gear({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('rune-turning', className)} aria-hidden>
      <path d="M34.32,3.09 L38.73,3.79 L40.83,10.76 L43.99,12.37 L50.87,9.98 L54.02,13.13 L51.63,20.01 L53.24,23.17 L60.21,25.27 L60.91,29.68 L54.93,33.84 L54.37,37.34 L58.78,43.14 L56.75,47.12 L49.47,46.96 L46.96,49.47 L47.12,56.75 L43.14,58.78 L37.34,54.37 L33.84,54.93 L29.68,60.91 L25.27,60.21 L23.17,53.24 L20.01,51.63 L13.13,54.02 L9.98,50.87 L12.37,43.99 L10.76,40.83 L3.79,38.73 L3.09,34.32 L9.07,30.16 L9.63,26.66 L5.22,20.86 L7.25,16.88 L14.53,17.04 L17.04,14.53 L16.88,7.25 L20.86,5.22 L26.66,9.63 L30.16,9.07 Z" fill="currentColor" fillOpacity=".25" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      <circle cx="32" cy="32" r="9" fill="none" stroke="currentColor" strokeWidth="5" />
    </svg>
  );
}

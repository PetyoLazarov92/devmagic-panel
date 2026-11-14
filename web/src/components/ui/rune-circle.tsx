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

/**
 * Grove's turning icon: a ring of leaves around a seed, turning slowly as one
 * while something runs.
 */
export function Sprout({ className }: { className?: string }) {
  const leaf = 'M32 6c6 6 6 14 0 20-6-6-6-14 0-20Z';
  return (
    <svg viewBox="0 0 64 64" className={cn('rune-turning', className)} style={{ animationDuration: '2.6s' }} aria-hidden>
      {[0, 72, 144, 216, 288].map((a, i) => (
        <path key={a} d={leaf} fill="currentColor" fillOpacity={0.3 + i * 0.15} transform={`rotate(${a} 32 32)`} />
      ))}
      <circle cx="32" cy="32" r="6" fill="currentColor" />
    </svg>
  );
}

/**
 * Abyss's turning icon: a spiral shell, turning slowly as one while something
 * runs.
 */
export function Shell({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('rune-turning', className)} style={{ animationDuration: '2.4s' }} aria-hidden>
      <path d="M35.0 32.0 L35.1 32.2 L35.2 32.4 L35.3 32.7 L35.4 32.9 L35.4 33.2 L35.5 33.5 L35.5 33.7 L35.5 34.0 L35.4 34.3 L35.4 34.6 L35.3 34.9 L35.2 35.3 L35.0 35.6 L34.9 35.9 L34.7 36.1 L34.5 36.4 L34.2 36.7 L34.0 37.0 L33.7 37.2 L33.4 37.4 L33.0 37.6 L32.7 37.8 L32.3 38.0 L31.9 38.1 L31.5 38.2 L31.0 38.3 L30.6 38.3 L30.1 38.4 L29.7 38.3 L29.2 38.3 L28.7 38.2 L28.3 38.1 L27.8 37.9 L27.3 37.7 L26.9 37.5 L26.4 37.2 L26.0 36.9 L25.6 36.6 L25.2 36.2 L24.8 35.8 L24.4 35.4 L24.1 34.9 L23.8 34.5 L23.5 33.9 L23.3 33.4 L23.1 32.8 L22.9 32.2 L22.8 31.6 L22.7 31.0 L22.7 30.4 L22.7 29.7 L22.7 29.1 L22.8 28.4 L23.0 27.8 L23.2 27.1 L23.4 26.5 L23.7 25.8 L24.0 25.2 L24.4 24.6 L24.8 24.0 L25.3 23.5 L25.8 22.9 L26.3 22.4 L26.9 21.9 L27.5 21.5 L28.2 21.1 L28.9 20.8 L29.6 20.5 L30.4 20.2 L31.1 20.0 L31.9 19.8 L32.8 19.7 L33.6 19.7 L34.4 19.7 L35.3 19.7 L36.1 19.9 L37.0 20.0 L37.8 20.3 L38.6 20.6 L39.4 20.9 L40.2 21.3 L41.0 21.8 L41.8 22.3 L42.5 22.9 L43.2 23.6 L43.8 24.3 L44.4 25.0 L45.0 25.8 L45.5 26.6 L45.9 27.5 L46.3 28.4 L46.6 29.3 L46.9 30.2 L47.1 31.2 L47.3 32.2 L47.4 33.3 L47.4 34.3 L47.3 35.3 L47.2 36.4 L47.0 37.4 L46.7 38.5 L46.4 39.5 L45.9 40.5 L45.5 41.5 L44.9 42.4 L44.3 43.3 L43.6 44.2 L42.8 45.1 L42.0 45.8 L41.2 46.6 L40.2 47.3 L39.3 47.9 L38.2 48.5 L37.2 49.0 L36.1 49.4 L34.9 49.8 L33.7 50.0 L32.5 50.2 L31.3 50.4 L30.1 50.4 L28.9 50.4 L27.6 50.3 L26.4 50.1 L25.2 49.8 L23.9 49.4 L22.7 48.9 L21.6 48.4 L20.4 47.8 L19.3 47.1 L18.3 46.3 L17.3 45.4 L16.3 44.5 L15.4 43.5 L14.6 42.4 L13.8 41.3 L13.1 40.2 L12.5 38.9 L11.9 37.7 L11.5 36.3 L11.1 35.0 L10.8 33.6 L10.6 32.2 L10.5 30.8 L10.5 29.3 L10.6 27.9 L10.8 26.5 L11.1 25.0 L11.5 23.6 L12.0 22.2 L12.6 20.9 L13.3 19.5 L14.0 18.2 L14.9 17.0 L15.8 15.8 L16.8 14.7 L17.9 13.6 L19.1 12.6 L20.4 11.7 L21.7 10.8 L23.1 10.1 L24.5 9.4 L26.0 8.8 L27.5 8.3 L29.1 8.0 L30.7 7.7 L32.3 7.5 L33.9 7.5 L35.5 7.5 L37.2 7.7 L38.8 8.0 L40.4 8.3 L42.0 8.8 L43.6 9.4 L45.1 10.2 L46.6 11.0 L48.1 11.9 L49.5 12.9 L50.8 14.0 L52.0 15.2 L53.2 16.5 L54.3 17.9 L55.3 19.3 L56.2 20.8 L57.0 22.4 L57.7 24.0 L58.3 25.7 L58.8 27.5 L59.2 29.2 L59.4 31.0 L59.6 32.9 L59.6 34.7 L59.5 36.5 L59.2 38.4 L58.9 40.2 L58.4 42.0 L57.8 43.8 L57.0 45.5 L56.2 47.2 L55.2 48.9" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Neon's turning icon: a cassette reel, its hub and three spokes turning as
 * one while something runs.
 */
export function Reel({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('rune-turning', className)} style={{ animationDuration: '1.8s' }} aria-hidden>
      <circle cx="32" cy="32" r="26" fill="none" stroke="currentColor" strokeWidth="5" strokeOpacity="0.45" />
      <circle cx="32" cy="32" r="9" fill="none" stroke="currentColor" strokeWidth="5" />
      {[0, 120, 240].map((a) => (
        <path key={a} d="M32 23V10" stroke="currentColor" strokeWidth="5" strokeLinecap="round" transform={`rotate(${a} 32 32)`} />
      ))}
    </svg>
  );
}

/**
 * Ink's turning icon: a brushed circle that draws itself, fades and draws
 * again (styles/ink.css), turning slowly as one while something runs.
 */
export function Enso({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('rune-turning', className)} style={{ animationDuration: '4s' }} aria-hidden>
      <path className="ink-enso" d="M44 12A24 24 0 1 1 22 11" pathLength={100} fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Dune's turning icon: an hourglass, sand in its lower half, turning slowly as
 * one while something runs.
 */
export function Hourglass({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('rune-turning', className)} style={{ animationDuration: '2.8s' }} aria-hidden>
      <path d="M18 8h28M18 56h28" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <path d="M21 8c0 14 22 16 22 24S21 42 21 56M43 8c0 14-22 16-22 24s22 10 22 24" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinejoin="round" />
      <path d="M24 54c2-6 5-8 8-9 3 1 6 3 8 9Z" fill="currentColor" fillOpacity="0.55" />
    </svg>
  );
}

/**
 * Pixel's turning icon: eight squares in a ring, faintest to brightest, turning
 * a square at a time (in steps, not smoothly) while something runs.
 */
export function PixelRing({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('rune-turning', className)} style={{ animationDuration: '1s', animationTimingFunction: 'steps(8)' }} shapeRendering="crispEdges" aria-hidden>
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => (
        <rect key={a} x="27" y="4" width="10" height="10" fill="currentColor" fillOpacity={0.23 + i * 0.11} transform={`rotate(${a} 32 32)`} />
      ))}
    </svg>
  );
}

/**
 * Sorbet's turning icon: three scoops, mint, strawberry and lemon, circling
 * one another while something runs.
 */
export function Scoops({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('rune-turning', className)} style={{ animationDuration: '1.8s' }} aria-hidden>
      <circle cx="32" cy="14" r="10" style={{ fill: 'var(--sb-berry, currentColor)' }} />
      <circle cx="47.6" cy="41" r="10" style={{ fill: 'var(--sb-mint, currentColor)' }} />
      <circle cx="16.4" cy="41" r="10" style={{ fill: 'var(--sb-lemon, currentColor)' }} />
    </svg>
  );
}

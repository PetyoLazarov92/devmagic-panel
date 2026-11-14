import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useActiveMode } from '@/lib/modes';
import { ChromeRing, Compass, Enso, Gear, HelmOfAwe, Hourglass, PixelRing, Scoops, Sunburst, Reel, RuneCircle, SegmentRing, Shell, Snowflake, Sprout } from '@/components/ui/rune-circle';

/**
 * Something is running: the one turning icon. Its size follows the place it is in (a button's
 * icon size, size-4 elsewhere); pass a `label` when nothing next to it says what runs.
 */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  // A mode turns its own icon instead: a rune circle in Wizard, a segmented ring in Circuit, a gear in Forge, a sprouting seed in Grove, a spiral shell in Abyss, a cassette reel in Neon, a brushed circle in Ink, an hourglass in Dune, a ring of squares in Pixel, three scoops in Sorbet, a sunburst in Art Deco, a chrome ring in Chrome, a compass in Atlas, a snowflake in Frostfall, the Helm of Awe in Hall of Storms.
  const { mode } = useActiveMode();
  return (
    <>
      {mode === 'wizard' ? <RuneCircle className={cn('size-4 shrink-0', className)} /> : mode === 'circuit' ? <SegmentRing className={cn('size-4 shrink-0', className)} /> : mode === 'forge' ? <Gear className={cn('size-4 shrink-0', className)} /> : mode === 'grove' ? <Sprout className={cn('size-4 shrink-0', className)} /> : mode === 'abyss' ? <Shell className={cn('size-4 shrink-0', className)} /> : mode === 'neon' ? <Reel className={cn('size-4 shrink-0', className)} /> : mode === 'ink' ? <Enso className={cn('size-4 shrink-0', className)} /> : mode === 'dune' ? <Hourglass className={cn('size-4 shrink-0', className)} /> : mode === 'pixel' ? <PixelRing className={cn('size-4 shrink-0', className)} /> : mode === 'sorbet' ? <Scoops className={cn('size-4 shrink-0', className)} /> : mode === 'deco' ? <Sunburst className={cn('size-4 shrink-0', className)} /> : mode === 'chrome' ? <ChromeRing className={cn('size-4 shrink-0', className)} /> : mode === 'atlas' ? <Compass className={cn('size-4 shrink-0', className)} /> : mode === 'frostfall' ? <Snowflake className={cn('size-4 shrink-0', className)} /> : mode === 'storms' ? <HelmOfAwe className={cn('size-4 shrink-0', className)} /> : <LoaderCircle className={cn('size-4 shrink-0 animate-spin', className)} aria-hidden />}
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}

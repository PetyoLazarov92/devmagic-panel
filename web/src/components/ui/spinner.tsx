import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useActiveMode } from '@/lib/modes';
import { Gear, RuneCircle, SegmentRing, Sprout } from '@/components/ui/rune-circle';

/**
 * Something is running: the one turning icon. Its size follows the place it is in (a button's
 * icon size, size-4 elsewhere); pass a `label` when nothing next to it says what runs.
 */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  // A mode turns its own icon instead: a rune circle in Wizard, a segmented ring in Circuit, a gear in Forge, a sprouting seed in Grove.
  const { mode } = useActiveMode();
  return (
    <>
      {mode === 'wizard' ? <RuneCircle className={cn('size-4 shrink-0', className)} /> : mode === 'circuit' ? <SegmentRing className={cn('size-4 shrink-0', className)} /> : mode === 'forge' ? <Gear className={cn('size-4 shrink-0', className)} /> : mode === 'grove' ? <Sprout className={cn('size-4 shrink-0', className)} /> : <LoaderCircle className={cn('size-4 shrink-0 animate-spin', className)} aria-hidden />}
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}

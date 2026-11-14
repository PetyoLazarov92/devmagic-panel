import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useActiveMode } from '@/lib/modes';
import { RuneCircle } from '@/components/ui/rune-circle';

/**
 * Something is running: the one turning icon. Its size follows the place it is in (a button's
 * icon size, size-4 elsewhere); pass a `label` when nothing next to it says what runs.
 */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  // In Wizard mode a rune circle turns instead.
  const wizard = useActiveMode().mode === 'wizard';
  return (
    <>
      {wizard ? <RuneCircle className={cn('size-4 shrink-0', className)} /> : <LoaderCircle className={cn('size-4 shrink-0 animate-spin', className)} aria-hidden />}
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}

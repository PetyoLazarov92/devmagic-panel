import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Something is running: the one turning icon. Its size follows the place it is in (a button's
 * icon size, size-4 elsewhere); pass a `label` when nothing next to it says what runs.
 */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <>
      <LoaderCircle className={cn('size-4 shrink-0 animate-spin', className)} aria-hidden />
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}

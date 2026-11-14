import type { ModeId } from '@devmagic-panel/shared';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A small panel in a mode's colors, whatever mode is on: for the Modes page and the unlock dialog. Sealed, it is blurred behind a lock. */
export function ModeThumb({ mode, sealed = false, reveal = false, className }: { mode: ModeId; sealed?: boolean; reveal?: boolean; className?: string }) {
  return (
    <div className={cn('mode-thumb', className)} data-thumb={mode} {...(sealed ? { 'data-sealed': '' } : {})} {...(reveal ? { 'data-reveal': '' } : {})} aria-hidden>
      <div className="mt-side"><i /><i /><i /><i /><i /></div>
      <div className="mt-main"><b /><i /><i /><i /><i /><i /><i /></div>
      {sealed && (
        <div className="mt-lock">
          <Lock className="size-7" strokeWidth={1.6} />
        </div>
      )}
    </div>
  );
}

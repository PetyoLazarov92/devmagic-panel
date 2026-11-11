import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One setting: what it is and what it does on the left, its control on the right (a Switch,
 * a Select, a button). On a phone the control goes under the text.
 */
export function SettingRow({ title, description, control, htmlFor, className, children }: { title: ReactNode; description?: ReactNode; control: ReactNode; htmlFor?: string; className?: string; children?: ReactNode }) {
  const Title = htmlFor ? 'label' : 'span';
  return (
    <div className={cn('grid gap-2', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-[1_1_16rem]">
          <Title {...(htmlFor ? { htmlFor } : {})} className="block text-sm font-medium">{title}</Title>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">{control}</div>
      </div>
      {children}
    </div>
  );
}

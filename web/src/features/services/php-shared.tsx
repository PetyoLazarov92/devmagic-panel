import { XDEBUG_MODES } from '@devmagic-panel/shared';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Notice } from '@/components/layout/page';

export const SAPI_LABEL = { apache2: 'Apache (mod_php)', fpm: 'PHP-FPM', cli: 'Command line' } as const;

export type Mode = (typeof XDEBUG_MODES)[number];

export const errorBox = (text: string) => <Notice>{text}</Notice>;

/** The sections of one version, in page order; /services/php/8.3/modules opens the version scrolled to one. */
export const PHP_SECTIONS = ['settings', 'modules', 'sites', 'xdebug', 'ini', 'info'] as const;
export type PhpSection = (typeof PHP_SECTIONS)[number];
export const sectionId = (section: PhpSection) => `php-${section}`;

/** A section that loads only once opened, like the info pages: PHP runs for each. */
export function Section({ title, icon, hint, children, defaultOpen = false, compact = false }: { title: string; icon: ReactNode; hint: string; children: (open: boolean) => ReactNode; defaultOpen?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const box = (
    <details open={defaultOpen} className={cn('group', compact && 'rounded-lg border')} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className={cn('flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden', compact ? 'px-4 py-3' : 'px-5 py-4')}>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
        {icon}
      </summary>
      {open && <div className={cn('border-t text-sm', compact ? 'px-4 py-3' : 'px-5 py-4')}>{children(open)}</div>}
    </details>
  );
  // A compact one sits inside a card; the others are cards of their own.
  return compact ? box : <Card className="lg:col-span-2">{box}</Card>;
}

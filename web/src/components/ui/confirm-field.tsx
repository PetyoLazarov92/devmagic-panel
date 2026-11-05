import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Type-to-confirm for changes that cannot be undone from the panel. The text
 * to type stands apart in a code chip with a copy button, so it is clear what
 * to type and what is only the instruction.
 */
export function ConfirmField({ id, expected, value, onChange, className }: { id: string; expected: string; value: string; onChange: (v: string) => void; className?: string }) {
  const [copied, setCopied] = useState(false);
  const matches = value === expected;
  return (
    <div className={cn('grid gap-1.5', className)}>
      <label htmlFor={id} className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        To confirm, type
        <code className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[13px] font-medium break-all text-foreground">{expected}</code>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1 text-xs hover:text-foreground"
          title="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(expected).then(() => setCopied(true));
          }}
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          <span className="sr-only">Copy {expected}</span>
        </button>
      </label>
      <div className="relative">
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} className="pr-9 font-mono text-[13px]" />
        {matches && <Check className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-success" aria-hidden />}
      </div>
    </div>
  );
}

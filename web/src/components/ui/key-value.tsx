import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface KeyValueRow {
  label: ReactNode;
  value: ReactNode;
  /** A key when the label is not a plain string. */
  key?: string;
}

const LABEL_WIDTH = { sm: 'grid-cols-[minmax(0,7rem)_minmax(0,1fr)]', md: 'grid-cols-[minmax(0,10rem)_minmax(0,1fr)]', auto: 'grid-cols-[auto_minmax(0,1fr)]' } as const;

/**
 * Facts as label and value. `inline` puts the label in a column on the left (a label width of
 * sm, md or auto); `stacked` puts it over its value, for narrow cards and long values.
 */
export function KeyValue({ rows, layout = 'inline', labelWidth = 'auto', dense = false, className }: { rows: KeyValueRow[]; layout?: 'inline' | 'stacked'; labelWidth?: keyof typeof LABEL_WIDTH; dense?: boolean; className?: string }) {
  const text = dense ? 'text-xs' : 'text-sm';
  if (layout === 'stacked') {
    return (
      <dl className={cn('grid gap-3', text, className)}>
        {rows.map((r, i) => (
          <div key={r.key ?? (typeof r.label === 'string' ? r.label : i)} className="grid min-w-0 gap-0.5">
            <dt className="text-xs text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">{r.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className={cn('grid gap-x-4', dense ? 'gap-y-1' : 'gap-y-1.5', LABEL_WIDTH[labelWidth], text, className)}>
      {rows.map((r, i) => (
        <Fragment key={r.key ?? (typeof r.label === 'string' ? r.label : i)}>
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{r.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

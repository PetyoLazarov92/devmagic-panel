import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

/**
 * The bar a form with several fields shows while it has changes: it sticks
 * to the bottom of the window, says what changed, and holds Discard and the
 * one button that saves or applies. Nothing shows while nothing changed.
 */
export function SaveBar({ changes, saving, label, error, note, onSave, onDiscard }: {
  changes: number;
  saving: boolean;
  label: string;
  error?: string | undefined;
  note?: ReactNode;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (changes === 0 && !saving) return null;
  return (
    <div className="sticky bottom-4 z-20">
      <Card role="region" aria-label="Unsaved changes" className="flex flex-wrap items-center gap-3 border-primary/40 px-5 py-3 text-sm shadow-lg">
        <div className="min-w-0 flex-[1_1_16rem]">
          <p className="font-medium">{saving ? 'Saving...' : `${changes} unsaved change${changes === 1 ? '' : 's'}`}</p>
          {error ? <p role="alert" className="text-xs text-danger">{error}</p> : note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
        </div>
        <Button variant="soft" disabled={saving} onClick={onDiscard}>Discard</Button>
        <Button disabled={saving || Boolean(error)} onClick={onSave}>
          {saving && <Spinner />}
          {label}
        </Button>
      </Card>
    </div>
  );
}

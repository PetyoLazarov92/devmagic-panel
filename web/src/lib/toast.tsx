import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';

/**
 * Short result notices for actions started from menus and the command
 * palette, where there is no inline place to show the outcome.
 */
export interface Toast {
  id: number;
  tone: 'success' | 'danger' | 'info';
  title: string;
  detail?: string;
  /** A newer toast with the same key takes the place of the older one, like a countdown. */
  key?: string;
  /** One button that acts on what the toast reports, like Undo; it closes the toast. */
  action?: { label: string; run: () => void };
}

const EVENT = 'dmp:toast';
let next = 1;

export function toast(t: Omit<Toast, 'id'>): void {
  window.dispatchEvent(new CustomEvent<Toast>(EVENT, { detail: { ...t, id: next++ } }));
}

const icons = {
  success: <CircleCheck className="size-4 text-success" aria-hidden />,
  danger: <CircleX className="size-4 text-danger" aria-hidden />,
  info: <Info className="size-4 text-primary" aria-hidden />,
};

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const onToast = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setToasts((list) => [...list.filter((x) => !t.key || x.key !== t.key).slice(-3), t]);
      window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== t.id)), t.tone === 'danger' || t.action ? 9000 : 5000);
    };
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-0 bottom-0 z-50 grid w-full max-w-sm gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      {toasts.map((t) => (
        <Card key={t.id} className="pointer-events-auto flex gap-3 px-4 py-3 text-sm shadow-lg">
          <span className="mt-0.5 shrink-0">{icons[t.tone]}</span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t.title}</p>
            {t.detail && <p className="mt-0.5 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">{t.detail}</p>}
          </div>
          {t.action && (
            <Button
              variant="soft"
              size="xs"
              onClick={() => {
                setToasts((list) => list.filter((x) => x.id !== t.id));
                t.action?.run();
              }}
              className="text-primary"
            >
              {t.action.label}
            </Button>
          )}
          <IconButton icon={X} label="Dismiss" onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))} className="size-6 text-muted-foreground hover:text-foreground [&_svg]:size-3.5" />
        </Card>
      ))}
    </div>
  );
}

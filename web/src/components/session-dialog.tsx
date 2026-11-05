import { useEffect, useId, useRef } from 'react';
import { Logo } from '@/components/logo';
import { LoginForm } from '@/pages/login';

/**
 * The login form over the page when its session ended: the page stays as it
 * was, blurred and out of reach (a modal <dialog> makes the rest inert), and
 * reloads once you are in. It cannot be closed: without a session the page
 * behind only fails.
 */
export function SessionDialog({ onLogin }: { onLogin: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      // Escape closes a modal dialog; this one stays.
      onCancel={(e) => e.preventDefault()}
      onClose={(e) => e.currentTarget.showModal()}
      className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-xl border bg-card p-5 text-card-foreground shadow-2xl backdrop:bg-background/50 backdrop:backdrop-blur-md"
    >
      <div className="mb-4 flex items-center gap-3">
        <Logo className="size-9 shrink-0" />
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-semibold tracking-tight">
            Your session ended
          </h2>
          <p className="text-sm text-muted-foreground">Log in again to carry on.</p>
        </div>
      </div>
      <LoginForm onLogin={onLogin} />
    </dialog>
  );
}

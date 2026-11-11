import { Logo } from '@/components/layout/logo';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { HINT_AFTER } from '@/lib/startup';
import { Spinner } from '@/components/ui/spinner';

/** While the panel does not answer yet, like a tab the browser restored right after you logged in. */
export function StartingScreen({ attempt, onRetry }: { attempt: number; onRetry: () => void }) {
  return (
    <main className="flex min-h-svh items-center justify-center px-6 py-12">
      <div className="w-full max-w-[400px]" role="status" aria-live="polite">
        <Logo className="mb-6 size-10" />
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Spinner className="size-5 text-muted-foreground" />
          Waiting for the panel to start
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The panel is not answering yet. Right after you log in it can take a few seconds to start. This page opens by itself once it answers.
        </p>
        {attempt >= HINT_AFTER && (
          <Notice tone="warning" className="mt-4">
            Still not answering. Check the service with <code className="font-mono text-xs">systemctl --user status devmagic-panel</code>, or start it with{' '}
            <code className="font-mono text-xs">systemctl --user start devmagic-panel</code>.
          </Notice>
        )}
        <Button className="mt-6" variant="outline" size="sm" onClick={onRetry}>
          Try now
        </Button>
      </div>
    </main>
  );
}

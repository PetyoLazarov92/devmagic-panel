import type { UpdateStatus } from '@devmagic-panel/shared';
import { CircleArrowUp, CloudOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Link } from '@/lib/router';

const chip = 'inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium whitespace-nowrap transition-colors [&_svg]:size-4';

const EVENT = 'dmp:update-status';

/** Hands the header a status read elsewhere, like Check again on the Updates page, so it shows at once. */
export function shareUpdate(status: UpdateStatus): void {
  window.dispatchEvent(new CustomEvent<UpdateStatus>(EVENT, { detail: status }));
}

/**
 * The update status: the server checks every six hours, this asks it every
 * half hour, and takes any status the Updates page reads in between.
 */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const look = () => api.update().then(setStatus, () => undefined);
    void look();
    const timer = window.setInterval(look, 30 * 60_000);
    const shared = (e: Event) => setStatus((e as CustomEvent<UpdateStatus>).detail);
    window.addEventListener(EVENT, shared);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(EVENT, shared);
    };
  }, []);
  return status;
}

/** What the sidebar's Updates item marks: a newer release, or no way left to read the releases. */
export function updateDot(status: UpdateStatus | null): 'new' | 'no-access' | null {
  if (!status) return null;
  if (status.available && status.latest) return 'new';
  return status.source || !status.access ? null : 'no-access';
}

/** A newer release, or no way left to read the releases, in the header. */
export function UpdateIndicator({ status }: { status: UpdateStatus | null }) {
  if (!status) return null;
  if (status.available && status.latest) {
    return (
      <Link href="/update" title="See what is new" aria-label={`${status.latest} available`} className={`${chip} border-primary/40 bg-primary/8 text-primary hover:bg-primary/12`}>
        <CircleArrowUp />
        <span className="hidden sm:inline">{status.latest} available</span>
      </Link>
    );
  }
  if (status.source || !status.access) return null;
  return (
    <Link href="/update" title="No way could read the panel's releases" aria-label="No access to updates" className={`${chip} border-warning/40 bg-warning/8 text-warning hover:bg-warning/12`}>
      <CloudOff />
      <span className="hidden sm:inline">No access to updates</span>
    </Link>
  );
}

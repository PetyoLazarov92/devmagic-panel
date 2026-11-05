import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const EVENT = 'dmp:mail-read';

/** Tells the sidebar a message was opened, so its count drops at once. */
export function mailRead(): void {
  window.dispatchEvent(new Event(EVENT));
}

/**
 * How many messages in Mailpit nobody has opened: asked every 30 seconds, on
 * each page change and when a message is opened; null while Mailpit is not running.
 */
export function useMailUnread(path: string): number | null {
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    const look = () => api.mailUnread().then((r) => setUnread(r.unread), () => undefined);
    void look();
    const timer = window.setInterval(look, 30_000);
    window.addEventListener(EVENT, look);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(EVENT, look);
    };
  }, [path]);
  return unread;
}

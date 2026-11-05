import { useSyncExternalStore } from 'react';

/** Whether the chat drawer is open, shared by the header button, Ctrl+K and the drawer. */
let open = false;
const listeners = new Set<() => void>();

export function setAssistantOpen(next: boolean): void {
  open = next;
  listeners.forEach((l) => l());
}

export function useAssistantOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
}

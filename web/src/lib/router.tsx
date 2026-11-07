import { type AnchorHTMLAttributes, type MouseEvent, useEffect, useState } from 'react';

/**
 * A minimal history router: the panel has a handful of routes, so a router
 * dependency would cost more than it saves. The current path is also kept in
 * memory, so navigation still works where the URL cannot change (the mockup
 * published as a sandboxed page).
 */
const EVENT = 'dmp:navigate';
let current = typeof window === 'undefined' ? '/' : window.location.pathname;
/** The query string, like ?tab=database, kept in memory with the path. */
let search = typeof window === 'undefined' ? '' : window.location.search;

/**
 * Goes to a path; a query string (like /mail?site=x) is kept in the URL, while
 * routes match on the path alone. With replace, the path takes the place of
 * the current one in the browser's history, and the page stays where it is;
 * scroll false keeps it where it is too, as for a tab. state goes with the
 * history entry, not the address: what a page hands the next one that must
 * not reach a URL or a log, like a filter's value; Back finds it again.
 */
export function navigate(to: string, { replace = false, scroll = !replace, state = null }: { replace?: boolean; scroll?: boolean; state?: unknown } = {}): void {
  const at = to.indexOf('?');
  const path = (at >= 0 ? to.slice(0, at) : to) || '/';
  const query = at >= 0 && at < to.length - 1 ? to.slice(at) : '';
  if (path === current && query === search) return;
  current = path;
  search = query;
  try {
    if (replace) window.history.replaceState(state, '', to);
    else window.history.pushState(state, '', to);
  } catch {
    // Sandboxed frames may refuse URL changes; the in-memory path still moves.
  }
  window.dispatchEvent(new Event(EVENT));
  if (scroll) window.scrollTo({ top: 0 });
}

export function usePath(): string {
  const [path, setPath] = useState(current);
  useEffect(() => {
    const onNavigate = () => setPath(current);
    const onPop = () => {
      current = window.location.pathname;
      search = window.location.search;
      setPath(current);
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener(EVENT, onNavigate);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener(EVENT, onNavigate);
    };
  }, []);
  return path;
}

/**
 * One value of the query string, like tab in ?tab=database, kept in step with
 * navigate and the browser's Back and Forward.
 */
export function useQueryParam(name: string): string | null {
  const read = () => new URLSearchParams(search).get(name);
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(new URLSearchParams(search).get(name));
    // Back and Forward change the query string without navigate.
    const onPop = () => {
      search = window.location.search;
      update();
    };
    update();
    window.addEventListener('popstate', onPop);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener(EVENT, update);
    };
  }, [name]);
  return value;
}

/** Matches "/sites/:domain" style patterns; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i] as string;
    const seg = s[i] as string;
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(seg);
    else if (part !== seg) return null;
  }
  return params;
}

export function Link({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  function handle(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  }
  return <a href={href} onClick={handle} {...props} />;
}

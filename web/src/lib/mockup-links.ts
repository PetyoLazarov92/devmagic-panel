/**
 * Whether a link would take the mockup somewhere else: another site, a
 * made-up local one, GitHub, a mail or editor link. Its own pages stay in.
 */
export function leavesMockup(href: string, origin: string): boolean {
  try {
    return new URL(href, origin).origin !== origin;
  } catch {
    return false;
  }
}

/**
 * In the mockup only: a link out, clicked or opened from code, shows where it
 * would go instead of leaving the demo, so a visitor never lands on a site
 * that is not there. A link marked data-mockup-exit (the demo's way to the
 * real panel) leaves as any link does.
 */
export function keepLinksInMockup(told: (url: string) => void): void {
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!(a instanceof HTMLAnchorElement) || a.hasAttribute('data-mockup-exit') || !leavesMockup(a.href, location.origin)) return;
      e.preventDefault();
      told(a.href);
    },
    true,
  );
  const open = window.open.bind(window);
  window.open = (url?: string | URL, ...rest) => {
    const href = url === undefined ? '' : String(url);
    if (href && href !== 'about:blank' && leavesMockup(href, location.origin)) {
      told(new URL(href, location.origin).href);
      return null;
    }
    return open(url, ...rest);
  };
}

/**
 * How wide a page's content runs, by its type (ui-ux.mdc, One layout per page type): every page
 * stops at about 1600px (the Sites list, a site, Activity, Services, WP Cores), and settings and
 * flows stay narrow enough to read. The top bar always runs the whole width.
 */
export type PageWidth = 'page' | 'narrow';

const NARROW = new Set(['/settings', '/update']);

export function pageWidth(path: string): PageWidth {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (NARROW.has(clean) || clean === '/sites/new' || clean.startsWith('/sites/new/')) return 'narrow';
  return 'page';
}

/** The main column's cap for each width: 100rem and 64rem. */
export const PAGE_MAX_WIDTH: Record<PageWidth, string> = {
  page: 'max-w-[100rem]',
  narrow: 'max-w-5xl',
};

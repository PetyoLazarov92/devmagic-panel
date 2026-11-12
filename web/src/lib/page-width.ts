/**
 * How wide a page's content runs, by its type (ui-ux.mdc, One layout per page type): lists and
 * grids of like items take a wide screen and add columns, a detail page with its side menu stops
 * at about 1600px so its cards stay in pairs, and settings and flows stay narrow enough to read.
 * The top bar always runs the whole width.
 */
export type PageWidth = 'wide' | 'detail' | 'narrow';

const WIDE = new Set(['/sites', '/services', '/activity', '/activity/runs', '/cores']);
const NARROW = new Set(['/settings', '/update']);

export function pageWidth(path: string): PageWidth {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (WIDE.has(clean)) return 'wide';
  if (NARROW.has(clean) || clean === '/sites/new' || clean.startsWith('/sites/new/')) return 'narrow';
  return 'detail';
}

/** The main column's cap for each width: 120rem, 100rem and 64rem. */
export const PAGE_MAX_WIDTH: Record<PageWidth, string> = {
  wide: 'max-w-[120rem]',
  detail: 'max-w-[100rem]',
  narrow: 'max-w-5xl',
};

/**
 * The panel's dialog widths, one set for every page: sm for a yes or no
 * question, md (the default) for a few fields, lg for choices side by side,
 * lists and previews, xl for tables, rows and diffs. A dialog never sets a
 * width of its own (web/test/dialog-sizes.test.ts keeps it so).
 */
export const DIALOG_SIZES = {
  sm: 'w-[min(24rem,calc(100vw-2rem))]',
  md: 'w-[min(32rem,calc(100vw-2rem))]',
  lg: 'w-[min(48rem,calc(100vw-2rem))]',
  xl: 'w-[min(64rem,calc(100vw-2rem))]',
} as const;
export type DialogSize = keyof typeof DIALOG_SIZES;

import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** tailwind-merge with the panel's own text sizes (index.css), so text-dense is a size, not a colour. */
const twMerge = extendTailwindMerge({ extend: { theme: { text: ['dense', '2xs'] } } });

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

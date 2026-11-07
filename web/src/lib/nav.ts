/** Whether a menu item is the page you are on, or a page under it; `also` holds other addresses it covers. */
export function navActive(item: { href: string; also?: string[] | undefined }, path: string): boolean {
  return [item.href, ...(item.also ?? [])].some((href) => path === href || path.startsWith(`${href}/`));
}

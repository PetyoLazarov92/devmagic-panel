/**
 * Pages that moved when the menu was grouped, and where they are now, so
 * bookmarks, the docs and links in old run output still land on the page.
 * Returns the new address with the old query kept, or null for a page that
 * did not move.
 */
const MOVED: Record<string, string> = {
  '/environment': '/aura/machine',
  '/environment/settings': '/settings',
  '/jobs': '/activity',
  '/runs': '/activity/runs',
  '/trash': '/sites?show=removed',
};

export function movedTo(path: string, search = ''): string | null {
  const to = MOVED[path];
  if (!to) return null;
  const [base, query = ''] = to.split('?');
  const params = new URLSearchParams(query);
  new URLSearchParams(search).forEach((value, key) => {
    if (!params.has(key)) params.set(key, value);
  });
  const q = params.toString();
  return `${base}${q ? `?${q}` : ''}`;
}

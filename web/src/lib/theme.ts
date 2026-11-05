import { useCallback, useEffect } from 'react';
import { savePreferences, usePreferences } from '@/lib/preferences';

export type Theme = 'light' | 'dark' | 'system';

const query = () => window.matchMedia('(prefers-color-scheme: dark)');

function apply(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && query().matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** Light, dark or system theme, kept with the other preferences in the panel's database. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const { theme } = usePreferences();

  useEffect(() => {
    apply(theme);
    if (theme !== 'system') return;
    const media = query();
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const update = useCallback((next: Theme) => savePreferences({ theme: next }), []);
  return [theme, update];
}

import { WP_RELEASES_URL } from '@devmagic-panel/shared';
import { TextLink } from '@/components/ui/text-link';

/** Where exact WordPress version numbers come from: WordPress.org's release list, each with its status. */
export function ReleaseListLink() {
  return (
    <>
      Exact numbers:{' '}
      <TextLink href={WP_RELEASES_URL}>WordPress.org release list</TextLink>{' '}
      (each marked latest, outdated or insecure).
    </>
  );
}

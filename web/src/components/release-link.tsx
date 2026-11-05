import { WP_RELEASES_URL } from '@devmagic-panel/shared';

/** Where exact WordPress version numbers come from: WordPress.org's release list, each with its status. */
export function ReleaseListLink() {
  return (
    <>
      Exact numbers:{' '}
      <a href={WP_RELEASES_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">
        WordPress.org release list
      </a>{' '}
      (each marked latest, outdated or insecure).
    </>
  );
}

import type { WporgDetails } from '@devmagic-panel/shared';
import { compareVersions, majorMinor } from './version-compare';

export interface CompatLine {
  label: string;
  value: string;
  /** ok: fine on this site; warning: tested with an older WordPress; danger: needs a newer one; plain: nothing to compare with. */
  tone: 'ok' | 'warning' | 'danger' | 'plain';
}

/**
 * What a plugin or theme needs, next to what the site has: the PHP and WordPress versions it
 * needs (a site below either is told in red) and the WordPress it was tested up to (a site on a
 * newer major or minor one is told in amber, as wp-admin does).
 */
export function compatLines(details: Pick<WporgDetails, 'requires' | 'tested' | 'requiresPhp'>, site: { wordpress?: string | undefined; php?: string | undefined }): CompatLine[] {
  const lines: CompatLine[] = [];
  if (details.requiresPhp) {
    lines.push(site.php
      ? { label: 'Requires PHP', value: `${details.requiresPhp}, the site runs ${site.php}`, tone: compareVersions(site.php, details.requiresPhp) < 0 ? 'danger' : 'ok' }
      : { label: 'Requires PHP', value: details.requiresPhp, tone: 'plain' });
  }
  if (details.requires) {
    lines.push(site.wordpress
      ? { label: 'Requires WordPress', value: `${details.requires}, the site has ${site.wordpress}`, tone: compareVersions(site.wordpress, details.requires) < 0 ? 'danger' : 'ok' }
      : { label: 'Requires WordPress', value: details.requires, tone: 'plain' });
  }
  if (details.tested) {
    lines.push(site.wordpress
      ? { label: 'Tested up to', value: `${details.tested}, the site has ${site.wordpress}`, tone: compareVersions(majorMinor(site.wordpress), majorMinor(details.tested)) > 0 ? 'warning' : 'ok' }
      : { label: 'Tested up to', value: details.tested, tone: 'plain' });
  }
  return lines;
}

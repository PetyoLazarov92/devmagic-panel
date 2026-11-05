import { describe, expect, it } from 'vitest';
import { pluginMatches } from '../src/lib/plugin-search.js';

describe('the plugin search', () => {
  it('finds a plugin by any part of its slug, whatever the case, spaces or hyphens', () => {
    for (const query of ['mail', 'Mailchimp', 'mail chimp', 'mailchimp-for', 'FOR WP']) expect(pluginMatches('mailchimp-for-wp', query)).toBe(true);
    expect(pluginMatches('wp-mail-smtp', 'wp mail')).toBe(true);
  });

  it('leaves out plugins that do not match, and keeps every one for an empty search', () => {
    expect(pluginMatches('wordfence', 'mail')).toBe(false);
    expect(pluginMatches('wordfence', '')).toBe(true);
    expect(pluginMatches('wordfence', '  -  ')).toBe(true);
  });
});

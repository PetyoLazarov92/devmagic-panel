import { describe, expect, it } from 'vitest';
import { pageWidth } from '../src/lib/page-width.js';

describe('pageWidth', () => {
  it('keeps settings, the update and the new site wizard narrow', () => {
    for (const path of ['/settings', '/update', '/sites/new', '/sites/new/abc123/domains']) expect(pageWidth(path)).toBe('narrow');
  });

  it('gives every other page one width: the sites, a site, a job, activity, services and the rest', () => {
    for (const path of ['/sites', '/sites/', '/sites/local.spellbook.example', '/sites/local.spellbook.example/learn', '/services', '/services/php', '/activity', '/activity/runs', '/cores', '/jobs/42', '/aura', '/mail', '/']) expect(pageWidth(path)).toBe('page');
  });
});

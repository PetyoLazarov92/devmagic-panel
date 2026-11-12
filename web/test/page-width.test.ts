import { describe, expect, it } from 'vitest';
import { pageWidth } from '../src/lib/page-width.js';

describe('pageWidth', () => {
  it('lets lists of like items run wide', () => {
    for (const path of ['/sites', '/sites/', '/services', '/activity', '/activity/runs', '/cores']) expect(pageWidth(path)).toBe('wide');
  });

  it('keeps settings, the update and the new site wizard narrow', () => {
    for (const path of ['/settings', '/update', '/sites/new', '/sites/new/abc123/domains']) expect(pageWidth(path)).toBe('narrow');
  });

  it('gives a site, a job, a section of services and the rest the detail width', () => {
    for (const path of ['/sites/local.spellbook.example', '/sites/local.spellbook.example/learn', '/services/php', '/jobs/42', '/aura', '/mail', '/']) expect(pageWidth(path)).toBe('detail');
  });
});

import { describe, expect, it } from 'vitest';
import { navActive } from '../src/lib/nav.js';
import { movedTo } from '../src/lib/moved.js';

describe('movedTo', () => {
  it('sends an old address to the page that has it now', () => {
    expect(movedTo('/environment/settings')).toBe('/settings');
    expect(movedTo('/jobs')).toBe('/activity');
    expect(movedTo('/environment')).toBe('/aura/machine');
    expect(movedTo('/trash')).toBe('/sites?show=removed');
  });

  it('keeps the query, like the page of the run history', () => {
    expect(movedTo('/runs', '?page=3')).toBe('/activity/runs?page=3');
    // A job's own page and a run's own page stay where they are.
    expect(movedTo('/jobs/abc')).toBeNull();
    expect(movedTo('/runs/42')).toBeNull();
  });

  it('leaves pages that did not move alone', () => {
    expect(movedTo('/sites')).toBeNull();
    expect(movedTo('/settings')).toBeNull();
  });
});

describe('navActive', () => {
  it('marks a page and the pages under it', () => {
    expect(navActive({ href: '/services' }, '/services/php/8.3')).toBe(true);
    expect(navActive({ href: '/sites' }, '/sites-x')).toBe(false);
    expect(navActive({ href: '/activity', also: ['/jobs', '/runs'] }, '/jobs/abc')).toBe(true);
  });
});

import type { DumpFacts, UploadResult } from '@devmagic-panel/shared';
import { describe, expect, it } from 'vitest';
import { adminChoices, type AdminState, cleanUserOf } from '../src/lib/admin-choice.js';

const upload = (facts: Partial<DumpFacts>): UploadResult => ({ id: 'u1', name: 'wandworks.sql', size: 1, facts: { multisite: false, hosts: [], partial: false, ...facts }, suggestions: { replace: [] } });
const state = (over: Partial<AdminState>): AdminState => ({ source: 'repo', upload: null, adminCreate: null, adminIfExists: 'keep', adminIfMissing: 'create', ...over });

describe('the admin user of an install', () => {
  it('touches no user when the dump has admins, until you switch the new one on', () => {
    const withAdmins = state({ upload: upload({ admins: ['admin', 'wandworksshop'] }) });
    expect(adminChoices(withAdmins)).toEqual({ ifExists: 'keep', ifMissing: 'skip' });
    expect(adminChoices({ ...withAdmins, adminCreate: true })).toEqual({ ifExists: 'update', ifMissing: 'create' });
  });

  it('makes one when the dump has none, and reads a network by its super admins', () => {
    expect(adminChoices(state({ upload: upload({ admins: [] }) }))).toEqual({ ifExists: 'update', ifMissing: 'create' });
    expect(adminChoices(state({ upload: upload({ multisite: true, admins: ['admin'], superAdmins: [] }) }))).toEqual({ ifExists: 'update', ifMissing: 'create' });
    expect(adminChoices(state({ upload: upload({ admins: [] }), adminCreate: false }))).toEqual({ ifExists: 'keep', ifMissing: 'skip' });
  });

  it('keeps your two choices for a dump whose users were not read, and for fresh WordPress', () => {
    expect(adminChoices(state({ upload: upload({ partial: true }), adminIfExists: 'update', adminIfMissing: 'skip' }))).toEqual({ ifExists: 'update', ifMissing: 'skip' });
    expect(adminChoices(state({ source: 'wordpress' }))).toEqual({ ifExists: 'keep', ifMissing: 'create' });
  });

  it("keeps the dump's own administrator when a copy is cleaned, else makes the admin with your password", () => {
    const withAdmins = state({ upload: upload({ admins: ['wandworksshop', 'Alex'] }) });
    expect(cleanUserOf(withAdmins, 'alex', 'pw')).toEqual({ keep: 'Alex', login: 'alex', password: 'pw' });
    expect(cleanUserOf({ ...withAdmins, adminCreate: true }, 'alex', 'pw')).toEqual({ login: 'alex', password: 'pw' });
    expect(cleanUserOf(withAdmins, 'admin', 'admin')).toEqual({ login: 'admin', password: 'admin' });
  });
});

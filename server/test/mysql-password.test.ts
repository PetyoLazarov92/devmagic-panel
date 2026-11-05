import { describe, expect, it } from 'vitest';
import { isPolicyRefusal, mysqlPassword } from '../src/sites/mysql-password.js';

describe('mysqlPassword', () => {
  it('always has a lowercase letter, an uppercase letter, a digit and a symbol, and nothing that needs escaping', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const p = mysqlPassword();
      expect(p).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[-_])[A-Za-z0-9_-]{24}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(2000);
  });

  it('recognizes a policy refusal', () => {
    expect(isPolicyRefusal('ERROR 1819 (HY000) at line 2: Your password does not satisfy the current policy requirements')).toBe(true);
    expect(isPolicyRefusal('ERROR 1007 (HY000): Can\'t create database')).toBe(false);
  });
});

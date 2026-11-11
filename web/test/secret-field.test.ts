import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_FIELD, secretFieldType } from '../src/lib/secret-field.js';

const SRC = join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

describe('secret fields', () => {
  it('carry every password manager ignore marker and turn autocomplete off', () => {
    expect(SECRET_FIELD).toMatchObject({
      autoComplete: 'off',
      'data-bwignore': 'true',
      'data-1p-ignore': 'true',
      'data-lpignore': 'true',
      'data-form-type': 'other',
    });
  });

  it('are text drawn as dots where the browser can, and a password field only where it cannot', () => {
    expect(secretFieldType(false, true)).toBe('text');
    expect(secretFieldType(true, true)).toBe('text');
    expect(secretFieldType(true, false)).toBe('text');
    expect(secretFieldType(false, false)).toBe('password');
  });

  it('leave real password fields to the panel login and the panel password, for managers to save', () => {
    const found = files(SRC)
      .filter((file) => !file.includes(`${join('src', 'mock')}`))
      .filter((file) => /type="password"|<PasswordInput\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
      .sort();
    expect(found).toEqual(['features/settings/panel-password.tsx', 'pages/login.tsx']);
  });
});

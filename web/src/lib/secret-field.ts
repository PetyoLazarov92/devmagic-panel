/**
 * A secret the browser must not offer to save: a sudo password, an API key, a
 * password for a site or a database. Browsers and password managers ignore
 * autocomplete="off" on a password field and offer to save what was typed once
 * the form goes, so where the browser can draw a text field as dots the secret
 * is a text field drawn that way, and each manager's own ignore marker is set.
 * Only the panel's own login keeps a real password field, for managers to fill.
 */
export const SECRET_FIELD = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  // Bitwarden, 1Password, LastPass and Dashlane each read their own.
  'data-bwignore': 'true',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-form-type': 'other',
} as const;

/** Whether this browser draws a text field as dots (Chrome, Safari, Edge, newer Firefox). */
export function drawsDots(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc');
}

/**
 * The field's type: text when shown, text drawn as dots where the browser can,
 * and a password field only where it cannot, so a secret never shows unasked.
 */
export function secretFieldType(shown: boolean, dots: boolean): 'text' | 'password' {
  return shown || dots ? 'text' : 'password';
}

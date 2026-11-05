/**
 * Scrubs anything secret-looking from text before it can reach a model:
 * wp-config.php credentials, salts and keys, Anthropic keys, passwords in
 * URLs or key=value form, and long random tokens. Over-redacting is fine;
 * the model only needs the shape of a problem.
 */
const RULES: Array<[RegExp, string]> = [
  // define( 'DB_PASSWORD', '...' ) and the eight salts and keys
  [/(define\s*\(\s*['"](?:DB_PASSWORD|DB_USER|(?:AUTH|SECURE_AUTH|LOGGED_IN|NONCE)_(?:KEY|SALT))['"]\s*,\s*)(['"])(?:\\.|(?!\2).)*\2/gi, '$1$2[redacted]$2'],
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, '[redacted key]'],
  // scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[redacted]@'],
  // password=..., "pass": "...", token: ...
  [/((?:pass(?:word)?|pwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1[redacted]'],
  // long hex or base64-like runs (hashes, nonces, session ids)
  [/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]'],
  [/\b[A-Za-z0-9+_-]{40,}={0,2}/g, '[redacted]'],
];

export function redact(text: string): string {
  return RULES.reduce((out, [re, to]) => out.replace(re, to), text);
}

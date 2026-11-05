import { DEFINE_VALUE } from './wpconfig.js';

/**
 * Edits wp-config.php text in place of `wp config set`, so secrets like the
 * database password never appear on a command line. Values are written as PHP
 * single-quoted strings, raw booleans or integers.
 */
export type ConfigValue = string | boolean | number;

const literal = (value: ConfigValue) => {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`not an integer: ${value}`);
    return String(value);
  }
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
};

const INSERT_BEFORE = [/\/\*\s*That's all, stop editing!/, /\/\*\*\s*Absolute path to the WordPress directory/, /require_once\s*\(?\s*ABSPATH/];

function insertLine(text: string, line: string): string {
  for (const marker of INSERT_BEFORE) {
    const m = marker.exec(text);
    if (m) return `${text.slice(0, m.index)}${line}\n\n${text.slice(m.index)}`;
  }
  return `${text.trimEnd()}\n${line}\n`;
}

/** Sets a define(), replacing the first live one or adding it before the end marker. */
export function setConstant(text: string, name: string, value: ConfigValue): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`not a constant name: ${name}`);
  const re = new RegExp(String.raw`^([ \t]*)define\s*\(\s*(['"])${name}\2\s*,\s*(?:${DEFINE_VALUE})\s*\)\s*;`, 'm');
  const line = `define( '${name}', ${literal(value)} );`;
  if (re.test(text)) return text.replace(re, (_m, indent: string) => `${indent}${line}`);
  return insertLine(text, line);
}

export function setTablePrefix(text: string, prefix: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(prefix)) throw new Error(`not a table prefix: ${prefix}`);
  const re = /^\$table_prefix\s*=\s*(['"])[^'"]*\1\s*;/m;
  const line = `$table_prefix = '${prefix}';`;
  return re.test(text) ? text.replace(re, line) : insertLine(text, line);
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The repository version from the root package.json (src/ and dist/ sit at the same depth). */
export function readVersion(): string {
  const file = fileURLToPath(new URL('../../package.json', import.meta.url));
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}

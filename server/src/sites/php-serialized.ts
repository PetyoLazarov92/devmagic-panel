/**
 * Reads a PHP serialized array of plain values, like the active_plugins
 * option: a:2:{i:0;s:19:"akismet/akismet.php";...}. Strings count bytes, so
 * it works on the UTF-8 bytes. Nested arrays are skipped, objects end the
 * read. Never runs or builds anything from the text: only strings, numbers,
 * booleans and null come out. Null for anything else.
 */
export type PhpScalar = string | number | boolean | null;

export function phpArray(text: string): Map<string | number, PhpScalar> | null {
  const bytes = Buffer.from(text, 'utf8');
  let at = 0;
  const char = () => String.fromCharCode(bytes[at] ?? 0);
  const expect = (c: string) => {
    if (char() !== c) throw new Error('bad');
    at++;
  };
  const until = (c: string) => {
    const end = bytes.indexOf(c.charCodeAt(0), at);
    if (end < 0) throw new Error('bad');
    const out = bytes.toString('utf8', at, end);
    at = end + 1;
    return out;
  };
  const value = (depth: number): PhpScalar | undefined => {
    const type = char();
    at++;
    if (type === 'N') {
      expect(';');
      return null;
    }
    expect(':');
    if (type === 'i' || type === 'd') {
      const n = Number(until(';'));
      if (!Number.isFinite(n)) throw new Error('bad');
      return n;
    }
    if (type === 'b') return until(';') === '1';
    if (type === 's') {
      const length = Number(until(':'));
      if (!Number.isInteger(length) || length < 0 || at + length + 2 > bytes.length) throw new Error('bad');
      expect('"');
      const s = bytes.toString('utf8', at, at + length);
      at += length;
      expect('"');
      expect(';');
      return s;
    }
    if (type === 'a' && depth < 8) {
      const count = Number(until(':'));
      expect('{');
      for (let i = 0; i < count; i++) {
        value(depth + 1);
        value(depth + 1);
      }
      expect('}');
      return undefined;
    }
    throw new Error('bad');
  };
  try {
    if (char() !== 'a') return null;
    at++;
    expect(':');
    const count = Number(until(':'));
    if (!Number.isInteger(count) || count < 0 || count > 100_000) return null;
    expect('{');
    const out = new Map<string | number, PhpScalar>();
    for (let i = 0; i < count; i++) {
      const key = value(1);
      const v = value(1);
      if ((typeof key === 'string' || typeof key === 'number') && v !== undefined) out.set(key, v);
    }
    expect('}');
    return out;
  } catch {
    return null;
  }
}

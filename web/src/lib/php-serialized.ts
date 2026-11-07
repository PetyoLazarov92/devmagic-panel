/**
 * Reads a PHP serialized value (what WordPress keeps in options and meta)
 * into a tree to show, without running anything: no class is made, an object
 * is only its name and properties. String lengths count UTF-8 bytes, as PHP's
 * do; a value whose lengths do not add up (a broken search and replace) is
 * not read and shows as text.
 */
export type PhpValue =
  | { type: 'null' }
  | { type: 'bool'; value: boolean }
  | { type: 'int' | 'float'; value: string }
  | { type: 'string'; value: string }
  | { type: 'array'; entries: Array<[PhpValue, PhpValue]> }
  | { type: 'object'; className: string; entries: Array<[PhpValue, PhpValue]> };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}

  char(): string {
    return String.fromCharCode(this.bytes[this.pos] ?? 0);
  }

  expect(text: string): void {
    for (const c of text) {
      if (this.char() !== c) throw new Error(`expected ${text} at ${this.pos}`);
      this.pos++;
    }
  }

  /** Up to the stop character, which is consumed. */
  until(stop: string): string {
    const start = this.pos;
    while (this.pos < this.bytes.length && this.char() !== stop) this.pos++;
    if (this.pos >= this.bytes.length) throw new Error('ended early');
    const out = decoder.decode(this.bytes.subarray(start, this.pos));
    this.pos++;
    return out;
  }

  count(stop: string): number {
    const n = this.until(stop);
    if (!/^\d{1,9}$/.test(n)) throw new Error(`not a length: ${n}`);
    return Number(n);
  }

  bytesOf(length: number): string {
    if (this.pos + length > this.bytes.length) throw new Error('a length runs past the end');
    const out = decoder.decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return out;
  }
}

const MAX_DEPTH = 64;

function entries(r: Reader, depth: number): Array<[PhpValue, PhpValue]> {
  const n = r.count(':');
  r.expect('{');
  const out: Array<[PhpValue, PhpValue]> = [];
  for (let i = 0; i < n; i++) out.push([value(r, depth + 1), value(r, depth + 1)]);
  r.expect('}');
  return out;
}

function value(r: Reader, depth: number): PhpValue {
  if (depth > MAX_DEPTH) throw new Error('too deep');
  const tag = r.char();
  r.pos++;
  if (tag === 'N') {
    r.expect(';');
    return { type: 'null' };
  }
  r.expect(':');
  switch (tag) {
    case 'b': {
      const v = r.until(';');
      if (v !== '0' && v !== '1') throw new Error('not a bool');
      return { type: 'bool', value: v === '1' };
    }
    case 'i': {
      const v = r.until(';');
      if (!/^-?\d+$/.test(v)) throw new Error('not an int');
      return { type: 'int', value: v };
    }
    case 'd': {
      const v = r.until(';');
      if (!/^(-?\d+(\.\d+)?([eE][-+]?\d+)?|-?INF|NAN)$/.test(v)) throw new Error('not a float');
      return { type: 'float', value: v };
    }
    case 's': {
      const length = r.count(':');
      r.expect('"');
      const v = r.bytesOf(length);
      r.expect('";');
      return { type: 'string', value: v };
    }
    case 'a':
      return { type: 'array', entries: entries(r, depth) };
    case 'O': {
      const length = r.count(':');
      r.expect('"');
      const className = r.bytesOf(length);
      r.expect('":');
      return { type: 'object', className, entries: entries(r, depth) };
    }
    default:
      throw new Error(`unknown type ${tag}`);
  }
}

/** The value as a tree, or null when the text is not a whole, intact serialized value. */
export function parsePhpSerialized(text: string): PhpValue | null {
  const trimmed = text.trim();
  if (!/^(?:[abidsO]:|N;)/.test(trimmed)) return null;
  try {
    const r = new Reader(encoder.encode(trimmed));
    const out = value(r, 0);
    return r.pos === r.bytes.length ? out : null;
  } catch {
    return null;
  }
}

/** A JSON object or array, for the pretty view; plain JSON strings and numbers stay text. */
export function parseJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Counts every s:N:"..." length again after a hand edit, in UTF-8 bytes as
 * PHP does. A string ends at the "; that is followed by what may follow a
 * value (another value, a closing brace or the end), so a "; inside a string
 * rarely misleads it. Null when even the result does not read as a whole value.
 */
export function fixSerializedLengths(text: string): string | null {
  const fixed = text.replace(/s:\d+:"([\s\S]*?)";(?=[}]|[sibdaO]:|N;|$)/g, (_, inner: string) => `s:${encoder.encode(inner).length}:"${inner}";`);
  return parsePhpSerialized(fixed) ? fixed : null;
}

export interface PropertyName {
  name: string;
  visibility: 'public' | 'protected' | 'private';
  /** The class a private property belongs to, which can be a parent of the object's. */
  owner?: string;
}

/**
 * An object property's name as PHP serializes it: `\0*\0name` is protected and
 * `\0Class\0name` private to Class; anything else is public.
 */
export function propertyName(key: string): PropertyName {
  const m = /^\0([^\0]+)\0([\s\S]*)$/.exec(key);
  if (!m) return { name: key, visibility: 'public' };
  const [, scope = '', name = ''] = m;
  return scope === '*' ? { name, visibility: 'protected' } : { name, visibility: 'private', owner: scope };
}

// Control characters other than tab and line breaks, which a page draws as nothing or a box.
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export interface TextRun {
  text: string;
  /** A control character: text is the character itself, label its name the way PHP writes it (`\0`, `\x1F`). */
  label?: string;
}

/** Text cut into plain runs and single control characters, each named for showing. */
export function controlRuns(text: string): TextRun[] {
  const out: TextRun[] = [];
  let last = 0;
  for (const m of text.matchAll(CONTROL)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    const code = m[0].charCodeAt(0);
    out.push({ text: m[0], label: code === 0 ? '\\0' : `\\x${code.toString(16).toUpperCase().padStart(2, '0')}` });
    last = at + 1;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/**
 * Text a plain text box would change or hide: control characters, and a
 * carriage return, which a text area turns into a plain line break.
 */
export function needsExactEditor(text: string): boolean {
  return /[\x00-\x08\x0B-\x1F\x7F]/.test(text);
}

// A property key with NUL bytes, as it sits in a serialized object, read even when lengths do not add up.
const MARKED_KEY = /:"\0(\*|[^\0"]+)\0([^\0"]*)";/g;

/**
 * The protected and private properties of the original that the edited text
 * no longer has as such: a NUL byte around the name deleted (which makes it
 * a new public property) or the property taken out. Counted, so one of two
 * properties of the same name is noticed too.
 */
export function lostPropertyMarks(original: string, edited: string): PropertyName[] {
  const keys = (text: string) => [...text.matchAll(MARKED_KEY)].map((m) => `\0${m[1] ?? ''}\0${m[2] ?? ''}`);
  const left = keys(edited);
  const lost: PropertyName[] = [];
  for (const key of keys(original)) {
    const at = left.indexOf(key);
    if (at === -1) lost.push(propertyName(key));
    else left.splice(at, 1);
  }
  return lost;
}

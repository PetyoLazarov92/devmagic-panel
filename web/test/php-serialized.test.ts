import { describe, expect, it } from 'vitest';
import { controlRuns, fixSerializedLengths, looksSerialized, lostPropertyMarks, needsExactEditor, parseJsonValue, parsePhpSerialized, propertyName, withNulMarks } from '../src/lib/php-serialized';

describe('PHP serialized values', () => {
  it('reads nested arrays with every scalar type', () => {
    expect(parsePhpSerialized('a:3:{i:0;s:4:"ride";s:2:"on";b:1;s:4:"rate";d:0.5;}')).toEqual({
      type: 'array',
      entries: [
        [{ type: 'int', value: '0' }, { type: 'string', value: 'ride' }],
        [{ type: 'string', value: 'on' }, { type: 'bool', value: true }],
        [{ type: 'string', value: 'rate' }, { type: 'float', value: '0.5' }],
      ],
    });
    expect(parsePhpSerialized('N;')).toEqual({ type: 'null' });
  });

  it('counts string lengths in UTF-8 bytes, as PHP does', () => {
    expect(parsePhpSerialized('s:5:"café";')).toEqual({ type: 'string', value: 'café' });
    expect(parsePhpSerialized('s:4:"café";')).toBeNull();
  });

  it('reads an object as its class name and properties, without making it', () => {
    expect(parsePhpSerialized('O:8:"stdClass":1:{s:4:"name";s:9:"Wandworks";}')).toEqual({
      type: 'object',
      className: 'stdClass',
      entries: [[{ type: 'string', value: 'name' }, { type: 'string', value: 'Wandworks' }]],
    });
  });

  it('refuses a value whose lengths do not add up, or that has more after it', () => {
    // What a plain-text search and replace leaves: the length still counts the old address.
    expect(parsePhpSerialized('a:1:{s:4:"home";s:32:"https://local.wandworks.example";}')).toBeNull();
    expect(parsePhpSerialized('a:1:{s:4:"home";s:31:"https://local.wandworks.example";}')).not.toBeNull();
    expect(parsePhpSerialized('i:1;i:2;')).toBeNull();
    expect(parsePhpSerialized('plain text')).toBeNull();
    expect(parsePhpSerialized('a:99999999999:{}')).toBeNull();
  });

  it('reads JSON objects and arrays only', () => {
    expect(parseJsonValue('{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(parseJsonValue('42')).toBeUndefined();
    expect(parseJsonValue('{broken')).toBeUndefined();
  });
});

describe('fixing serialized lengths after an edit', () => {
  it('counts each string again in UTF-8 bytes', () => {
    const edited = 'a:2:{s:4:"home";s:22:"https://local.wandworks-bikes.example";s:4:"name";s:4:"Café Wandworks";}';
    expect(parsePhpSerialized(edited)).toBeNull();
    const fixed = fixSerializedLengths(edited);
    expect(fixed).toBe('a:2:{s:4:"home";s:37:"https://local.wandworks-bikes.example";s:4:"name";s:15:"Café Wandworks";}');
    expect(parsePhpSerialized(fixed as string)).not.toBeNull();
  });

  it('gives up on what still does not read', () => {
    expect(fixSerializedLengths('a:2:{s:4:"home";}')).toBeNull();
  });
});

describe('protected and private properties', () => {
  // As PHP writes them: protected as \0*\0name, private as \0Class\0name.
  const text = 'O:23:"Wandworks_Task_Schedule":3:{s:9:"\0*\0recurs";i:86400;s:30:"\0Wandworks_Task_Schedule\0start";i:1780000000;s:4:"name";s:5:"daily";}';

  it('reads the object, with the NUL bytes counted in the lengths', () => {
    const v = parsePhpSerialized(text);
    expect(v?.type).toBe('object');
    expect(v?.type === 'object' && v.entries.map(([k]) => (k.type === 'string' ? propertyName(k.value) : null))).toEqual([
      { name: 'recurs', visibility: 'protected' },
      { name: 'start', visibility: 'private', owner: 'Wandworks_Task_Schedule' },
      { name: 'name', visibility: 'public' },
    ]);
  });

  it('names control characters the way PHP writes them, keeps the character itself, and leaves tabs and line breaks', () => {
    expect(controlRuns('\0*\0recurs')).toEqual([
      { text: '\0', label: '\\0' },
      { text: '*' },
      { text: '\0', label: '\\0' },
      { text: 'recurs' },
    ]);
    expect(controlRuns('a\x1Fb')).toEqual([{ text: 'a' }, { text: '\x1F', label: '\\x1F' }, { text: 'b' }]);
    expect(controlRuns('one\ttwo\nthree')).toEqual([{ text: 'one\ttwo\nthree' }]);
    expect(controlRuns('')).toEqual([]);
    // Put back together, the runs are the text, byte for byte.
    expect(controlRuns('\0*\0recurs').map((r) => r.text).join('')).toBe('\0*\0recurs');
  });
});

describe('editing values with NUL bytes', () => {
  const original = 'O:23:"Wandworks_Task_Schedule":3:{s:9:"\0*\0recurs";i:86400;s:30:"\0Wandworks_Task_Schedule\0start";i:1780000000;s:4:"name";s:5:"daily";}';

  it('picks the exact editor for control characters and carriage returns, not for tabs and line breaks', () => {
    expect(needsExactEditor(original)).toBe(true);
    expect(needsExactEditor('one\r\ntwo')).toBe(true);
    expect(needsExactEditor('one\ttwo\nthree')).toBe(false);
    expect(needsExactEditor('a:1:{s:4:"cart";a:0:{}}')).toBe(false);
  });

  it('finds nothing lost when the marks stay, whatever else changed', () => {
    expect(lostPropertyMarks(original, original.replace('i:86400', 'i:3600'))).toEqual([]);
    expect(lostPropertyMarks(original, original.replace('s:5:"daily"', 's:6:"weekly"'))).toEqual([]);
  });

  it('names a property whose NUL byte was deleted, even once the lengths are counted again', () => {
    const deleted = original.replace('\0*\0recurs', '*\0recurs');
    expect(lostPropertyMarks(original, deleted)).toEqual([{ name: 'recurs', visibility: 'protected' }]);
    const recounted = fixSerializedLengths(deleted);
    expect(recounted).not.toBeNull();
    expect(lostPropertyMarks(original, recounted as string)).toEqual([{ name: 'recurs', visibility: 'protected' }]);
  });

  it('names a private property taken out, with the class it belongs to', () => {
    const taken = original.replace('s:30:"\0Wandworks_Task_Schedule\0start";i:1780000000;', '').replace(':3:{', ':2:{');
    expect(lostPropertyMarks(original, taken)).toEqual([{ name: 'start', visibility: 'private', owner: 'Wandworks_Task_Schedule' }]);
  });
});

describe('typing \\0 for a NUL byte', () => {
  const real = 'O:23:"Wandworks_Task_Schedule":2:{s:9:"\0*\0recurs";i:86400;s:30:"\0Wandworks_Task_Schedule\0start";i:1780000000;}';

  it('turns typed marks into NUL bytes when the lengths count them as one byte', () => {
    const typed = 'O:23:"Wandworks_Task_Schedule":2:{s:9:"\\0*\\0recurs";i:86400;s:30:"\\0Wandworks_Task_Schedule\\0start";i:1780000000;}';
    expect(parsePhpSerialized(typed)).toBeNull();
    expect(withNulMarks(typed)).toBe(real);
  });

  it('counts the lengths again when they were written for the typed text', () => {
    const typed = 'O:23:"Wandworks_Task_Schedule":2:{s:11:"\\0*\\0recurs";i:86400;s:32:"\\0Wandworks_Task_Schedule\\0start";i:1780000000;}';
    expect(withNulMarks(typed)).toBe(real);
  });

  it('leaves a \\0 that is not around a property name, and gives nothing when there is no mark', () => {
    const regex = 'a:1:{s:7:"pattern";s:6:"a\\0b\\0c";}';
    expect(withNulMarks(regex)).toBeNull();
    expect(withNulMarks('a:1:{s:4:"text";s:5:"plain";}')).toBeNull();
    // A mark in a value that still does not read is not offered.
    expect(withNulMarks('O:23:"Wandworks_Task_Schedule":1:{s:9:"\\0*\\0recurs";i:86400')).toBeNull();
  });

  it('knows a serialized array or object by its start', () => {
    expect(looksSerialized('O:23:"Wandworks_Task_Schedule":1:{')).toBe(true);
    expect(looksSerialized('a:2:{i:0;')).toBe(true);
    expect(looksSerialized('Wandworks')).toBe(false);
    expect(looksSerialized('{"theme":"dark"}')).toBe(false);
  });
});

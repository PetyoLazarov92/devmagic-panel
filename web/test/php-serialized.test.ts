import { describe, expect, it } from 'vitest';
import { fixSerializedLengths, parseJsonValue, parsePhpSerialized } from '../src/lib/php-serialized';

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
    expect(parsePhpSerialized('O:8:"stdClass":1:{s:4:"name";s:4:"Acme";}')).toEqual({
      type: 'object',
      className: 'stdClass',
      entries: [[{ type: 'string', value: 'name' }, { type: 'string', value: 'Acme' }]],
    });
  });

  it('refuses a value whose lengths do not add up, or that has more after it', () => {
    // What a plain-text search and replace leaves: the length still counts the old address.
    expect(parsePhpSerialized('a:1:{s:4:"home";s:23:"https://local.acme.com";}')).toBeNull();
    expect(parsePhpSerialized('a:1:{s:4:"home";s:22:"https://local.acme.com";}')).not.toBeNull();
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
    const edited = 'a:2:{s:4:"home";s:22:"https://local.acme-bikes.com";s:4:"name";s:4:"Café Acme";}';
    expect(parsePhpSerialized(edited)).toBeNull();
    const fixed = fixSerializedLengths(edited);
    expect(fixed).toBe('a:2:{s:4:"home";s:28:"https://local.acme-bikes.com";s:4:"name";s:10:"Café Acme";}');
    expect(parsePhpSerialized(fixed as string)).not.toBeNull();
  });

  it('gives up on what still does not read', () => {
    expect(fixSerializedLengths('a:2:{s:4:"home";}')).toBeNull();
  });
});

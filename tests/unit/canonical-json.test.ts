import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalizeJsonText, canonicalizeJsonValue } from '../../src/canonical-json.js';

const FIXTURES = new URL('../fixtures/notary/', import.meta.url);

// Expected outputs below were produced by Python 3.13:
//   json.dumps(value, sort_keys=True, separators=(',', ':'))
describe('canonicalizeJsonText (Python json.dumps compatible)', () => {
  it('matches Python byte for byte on the gateway-signed raw document', () => {
    const text = readFileSync(new URL('raw-document.json', FIXTURES), 'utf8');
    const expected = readFileSync(new URL('raw-document.canonical.txt', FIXTURES), 'utf8');
    expect(canonicalizeJsonText(text, ['data'])).toBe(expected);
  });

  it('prints floats as Python repr', () => {
    const input =
      '[1.0,2.0,0.1,1e16,9999999999999998.0,1e15,123456789012345.6,1e-4,1e-5,1.5e-7,5e-324,' +
      '1.7976931348623157e308,-2.5,3.14159,1e22,1e21,100.0,0.5,-0.0,1E2,2.50]';
    expect(canonicalizeJsonText(input)).toBe(
      '[1.0,2.0,0.1,1e+16,9999999999999998.0,1000000000000000.0,123456789012345.6,0.0001,1e-05,1.5e-07,' +
        '5e-324,1.7976931348623157e+308,-2.5,3.14159,1e+22,1e+21,100.0,0.5,-0.0,100.0,2.5]',
    );
  });

  it('keeps integers exact, including beyond 2^53, and prints -0 as 0', () => {
    expect(canonicalizeJsonText('[123456789012345678901234567890,-9007199254740993,-0]')).toBe(
      '[123456789012345678901234567890,-9007199254740993,0]',
    );
  });

  it('sorts keys by code point, not UTF-16 code unit', () => {
    // U+FF21 < U+1F600 by code point; JS default sort puts the emoji first
    expect(canonicalizeJsonText('{"\\ud83d\\ude00":1,"\\uff21":2,"b":3,"a":4}')).toBe(
      '{"a":4,"b":3,"\\uff21":2,"\\ud83d\\ude00":1}',
    );
  });

  it('escapes like ensure_ascii=True', () => {
    expect(canonicalizeJsonText('"é日😀\\u007f/\\"\\\\\\b\\f\\n\\r\\t\\u0001"')).toBe(
      '"\\u00e9\\u65e5\\ud83d\\ude00\\u007f/\\"\\\\\\b\\f\\n\\r\\t\\u0001"',
    );
  });

  it('keeps the last value of a duplicate key, like json.loads', () => {
    expect(canonicalizeJsonText('{"a":1,"a":2}')).toBe('{"a":2}');
  });

  it('extracts a member by path, or returns undefined', () => {
    const text = '{"metadata":{"data":{"y":1,"x":[true,null]}}}';
    expect(canonicalizeJsonText(text, ['metadata', 'data'])).toBe('{"x":[true,null],"y":1}');
    expect(canonicalizeJsonText(text, ['missing'])).toBeUndefined();
  });

  it.each(['{', '{"a":}', '[1,]', '"unterminated', '01', 'NaN', '{"a":1} x'])('rejects invalid JSON: %s', (text) => {
    expect(() => canonicalizeJsonText(text)).toThrow(SyntaxError);
  });
});

describe('canonicalizeJsonValue', () => {
  it('canonicalises the JSON.stringify form of a value', () => {
    expect(canonicalizeJsonValue({ b: 'é', a: [1, 2.5, null] })).toBe('{"a":[1,2.5,null],"b":"\\u00e9"}');
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalizeJsonValue(undefined)).toThrow(TypeError);
  });
});

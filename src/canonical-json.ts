/**
 * Canonical JSON, byte-compatible with the gateway and the Python tools:
 *
 *     json.dumps(value, sort_keys=True, separators=(',', ':'))   # ensure_ascii=True
 *
 * This is the cross-tool convention for notary `data_hash` and raw-document
 * `content_hash` (SDK, CLI, MCP, gateway). Matching it from JavaScript needs
 * more than sorting keys:
 *
 * - Keys sort by Unicode code point (Python), not UTF-16 code unit (JS sort).
 * - Every character outside printable ASCII is escaped as \uXXXX (lowercase),
 *   astral characters as surrogate pairs; \b \f \n \r \t use short escapes.
 * - Floats print as Python's repr ("2.0", "1e+16", "1.5e-07"); integers keep
 *   all their digits, including beyond 2^53.
 *
 * The last point is why canonicalisation works on JSON text: once JSON.parse
 * has turned "2.0" into 2 or rounded a 30-digit integer, the original form is
 * gone. `canonicalizeJsonText` parses losslessly; `canonicalizeJsonValue` is
 * for values this SDK serialises itself (the gateway sees JSON.stringify output,
 * so both sides start from the same text).
 */

type JsonNode =
  | { kind: 'object'; entries: Map<string, JsonNode> }
  | { kind: 'array'; items: JsonNode[] }
  | { kind: 'string'; value: string }
  | { kind: 'number'; literal: string }
  | { kind: 'literal'; text: 'true' | 'false' | 'null' };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// eslint-disable-next-line no-control-regex
const STRING_SPECIAL = /["\\\u0000-\u001f]/g;

/**
 * Nesting limit. The parser is recursive; this keeps it far below the JS stack
 * limit. The gateway cannot sign anything this deep either (Python's json is
 * limited by its ~1000-frame recursion limit).
 */
export const MAX_JSON_DEPTH = 1000;

class LosslessParser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly text: string) {}

  parse(): JsonNode {
    const node = this.value();
    this.ws();
    if (this.pos !== this.text.length) this.fail('Unexpected trailing content');
    return node;
  }

  private fail(message: string): never {
    throw new SyntaxError(`${message} at position ${this.pos}`);
  }

  private ws(): void {
    while (this.pos < this.text.length && ' \t\n\r'.includes(this.text[this.pos]!)) this.pos++;
  }

  private value(): JsonNode {
    this.ws();
    const c = this.text[this.pos];
    if (c === '{' || c === '[') {
      if (++this.depth > MAX_JSON_DEPTH) this.fail(`Nesting deeper than ${MAX_JSON_DEPTH}`);
      const node = c === '{' ? this.object() : this.array();
      this.depth--;
      return node;
    }
    if (c === '"') return { kind: 'string', value: this.string() };
    for (const text of ['true', 'false', 'null'] as const) {
      if (this.text.startsWith(text, this.pos)) {
        this.pos += text.length;
        return { kind: 'literal', text };
      }
    }
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (!match) this.fail('Unexpected token');
    this.pos += match[0].length;
    return { kind: 'number', literal: match[0] };
  }

  private object(): JsonNode {
    this.pos++; // {
    // Duplicate keys: the last value wins, as in Python's json.loads
    const entries = new Map<string, JsonNode>();
    this.ws();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return { kind: 'object', entries };
    }
    for (;;) {
      this.ws();
      if (this.text[this.pos] !== '"') this.fail('Expected object key');
      const key = this.string();
      this.ws();
      if (this.text[this.pos] !== ':') this.fail("Expected ':'");
      this.pos++;
      entries.set(key, this.value());
      this.ws();
      const c = this.text[this.pos++];
      if (c === '}') return { kind: 'object', entries };
      if (c !== ',') this.fail("Expected ',' or '}'");
    }
  }

  private array(): JsonNode {
    this.pos++; // [
    const items: JsonNode[] = [];
    this.ws();
    if (this.text[this.pos] === ']') {
      this.pos++;
      return { kind: 'array', items };
    }
    for (;;) {
      items.push(this.value());
      this.ws();
      const c = this.text[this.pos++];
      if (c === ']') return { kind: 'array', items };
      if (c !== ',') this.fail("Expected ',' or ']'");
    }
  }

  private string(): string {
    this.pos++; // opening quote
    let out = '';
    for (;;) {
      // Copy the run up to the next quote, backslash or control character in one slice
      STRING_SPECIAL.lastIndex = this.pos;
      const special = STRING_SPECIAL.exec(this.text);
      const end = special ? special.index : this.text.length;
      out += this.text.slice(this.pos, end);
      this.pos = end;
      const c = this.text[this.pos++];
      if (c === undefined) this.fail('Unterminated string');
      if (c === '"') return out;
      if (c < ' ') this.fail('Unescaped control character in string');
      const e = this.text[this.pos++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const hex = this.text.slice(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 4;
          break;
        }
        default:
          this.fail('Invalid escape');
      }
    }
  }
}

/** Python's code-point ordering of str keys (JS sort compares UTF-16 units). */
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

// Everything Python's ensure_ascii escapes: quote, backslash, and all but printable ASCII
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /["\\\u0000-\u001f\u007f-\uffff]/g;

/** Python json.dumps string encoding with ensure_ascii=True. */
function emitString(value: string): string {
  // Per UTF-16 code unit: astral characters come out as surrogate pairs, which
  // is what Python emits for them; lone surrogates round-trip unchanged.
  const escaped = value.replace(
    NEEDS_ESCAPE,
    (c) => SHORT_ESCAPES[c] ?? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  return `"${escaped}"`;
}

/** Python repr() of a float, which json.dumps uses. */
function pythonFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';

  // Both languages print the shortest round-tripping digits; only layout differs.
  const [mantissa, expText] = Math.abs(x).toExponential().split('e') as [string, string];
  const digits = mantissa.replace('.', '');
  const exp = Number(expText);
  const sign = x < 0 ? '-' : '';

  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = `${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
    return `${sign}${m}e${e}`;
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  const padded = digits.padEnd(exp + 1, '0');
  const fraction = padded.slice(exp + 1);
  return `${sign}${padded.slice(0, exp + 1)}.${fraction || '0'}`;
}

function emitNumber(literal: string): string {
  if (/^-?\d+$/.test(literal)) {
    // Python int: arbitrary precision, printed as-is ("-0" parses to 0)
    return literal === '-0' ? '0' : literal;
  }
  return pythonFloatRepr(Number(literal));
}

function emit(node: JsonNode): string {
  switch (node.kind) {
    case 'object': {
      const keys = [...node.entries.keys()].sort(compareCodePoints);
      return `{${keys.map((k) => `${emitString(k)}:${emit(node.entries.get(k)!)}`).join(',')}}`;
    }
    case 'array':
      return `[${node.items.map(emit).join(',')}]`;
    case 'string':
      return emitString(node.value);
    case 'number':
      return emitNumber(node.literal);
    case 'literal':
      return node.text;
  }
}

/**
 * Canonical form of JSON text, or of one member of it: `path` walks object
 * keys, e.g. ['metadata', 'data']. Returns undefined if the path is absent.
 * Throws SyntaxError on invalid JSON.
 */
export function canonicalizeJsonText(text: string, path: readonly string[] = []): string | undefined {
  let node: JsonNode | undefined = new LosslessParser(text).parse();
  for (const key of path) {
    node = node.kind === 'object' ? node.entries.get(key) : undefined;
    if (!node) return undefined;
  }
  return emit(node);
}

/**
 * Canonical form of a value this SDK serialises itself with JSON.stringify.
 * Throws TypeError for values JSON cannot represent (e.g. undefined, BigInt).
 */
export function canonicalizeJsonValue(value: unknown): string {
  // A string's canonical form needs no parse (base64 `data` can be megabytes)
  if (typeof value === 'string') return emitString(value);
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Value is not representable as JSON');
  return canonicalizeJsonText(text)!;
}

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Convert various input types to Uint8Array
 */
export function toBytes(input: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  // String - encode as UTF-8
  return new TextEncoder().encode(input);
}

/**
 * Compute SHA256 hash and return as hex string
 */
export function sha256Hex(data: Uint8Array | ArrayBuffer | string): string {
  const bytes = toBytes(data);
  const hash = sha256(bytes);
  return bytesToHex(hash);
}

/**
 * Encode bytes to base64 string
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // Browser and Node.js compatible approach
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  // Browser fallback
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Decode base64 string to bytes
 */
export function base64ToBytes(base64: string): Uint8Array {
  // Browser and Node.js compatible approach
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  // Browser fallback
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Check if a string is valid hex
 */
export function isValidHex(str: string): boolean {
  return /^[0-9a-fA-F]+$/.test(str);
}

/** 64 hex characters, or 128 for an encrypted reference; optional 0x prefix */
const SWARM_REFERENCE = /^(?:0x)?(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/i;

/**
 * Check if a string looks like a valid Swarm reference: 64 hex characters, or
 * 128 for an encrypted reference, with an optional 0x prefix. This is what the
 * gateway and the CLI accept.
 */
export function isValidSwarmReference(ref: string): boolean {
  return typeof ref === 'string' && SWARM_REFERENCE.test(ref);
}

/**
 * The reference as it goes into the request path: validated, 0x prefix removed.
 * Returns undefined if it is not a valid Swarm reference.
 */
export function referencePathSegment(ref: string): string | undefined {
  if (!isValidSwarmReference(ref)) return undefined;
  return /^0x/i.test(ref) ? ref.slice(2) : ref;
}

/**
 * Normalize a Swarm reference (lowercase, trim)
 */
export function normalizeReference(ref: string): string {
  return ref.trim().toLowerCase();
}

/**
 * Seconds to wait from a Retry-After header (RFC 9110): delta-seconds, or an
 * HTTP date (seconds from `now`, rounded up; 0 if past). Undefined if the
 * header is missing or neither form.
 */
export function retryAfterSeconds(value: string | null | undefined, now: number = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text);
  const at = parseHttpDate(text, now);
  if (at === undefined) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const LONG_DAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH = `(${MONTHS.join('|')})`;
const TIME = '(\\d{2}):(\\d{2}):(\\d{2})';
/** Sun, 06 Nov 1994 08:49:37 GMT */
const IMF_FIXDATE = new RegExp(`^${DAY}, (\\d{2}) ${MONTH} (\\d{4}) ${TIME} GMT$`);
/** Sunday, 06-Nov-94 08:49:37 GMT (obsolete) */
const RFC850_DATE = new RegExp(`^${LONG_DAY}, (\\d{2})-${MONTH}-(\\d{2}) ${TIME} GMT$`);
/** Sun Nov  6 08:49:37 1994 (obsolete; GMT) */
const ASCTIME_DATE = new RegExp(`^${DAY} ${MONTH} ([ \\d]\\d) ${TIME} (\\d{4})$`);

/**
 * Parse an RFC 9110 HTTP-date (IMF-fixdate, or the obsolete RFC 850 and
 * asctime forms), always as GMT. Returns epoch milliseconds, or undefined for
 * anything else: Date.parse is too lenient (it reads 'foo 1' as a date in 2001,
 * and asctime as local time).
 */
function parseHttpDate(text: string, now: number): number | undefined {
  // Fields in the order day, month, year, hour, minute, second
  let fields: string[];
  let m: RegExpExecArray | null;
  if ((m = IMF_FIXDATE.exec(text))) {
    fields = [m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!];
  } else if ((m = RFC850_DATE.exec(text))) {
    // RFC 9110: a two-digit year more than 50 years in the future is in the past century
    let year = 2000 + Number(m[3]);
    if (year > new Date(now).getUTCFullYear() + 50) year -= 100;
    fields = [m[1]!, m[2]!, String(year), m[4]!, m[5]!, m[6]!];
  } else if ((m = ASCTIME_DATE.exec(text))) {
    fields = [m[2]!, m[1]!, m[6]!, m[3]!, m[4]!, m[5]!];
  } else {
    return undefined;
  }
  const [day, month, year, hour, minute, second] = fields as [string, string, string, string, string, string];
  const [d, h, mi, s] = [Number(day.trim()), Number(hour), Number(minute), Number(second)];
  if (h > 23 || mi > 59 || s > 60) return undefined;
  const at = Date.UTC(Number(year), MONTHS.indexOf(month), d, h, mi, s);
  // Reject a day the month does not have (Date.UTC would roll it over)
  if (new Date(at).getUTCDate() !== d) return undefined;
  return at;
}

/** 0x followed by 40 hex characters (any case; no checksum check) */
export function isAddress(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Prefix of the owner-proof message the gateway verifies (swarm_connect signed_auth.py) */
const OWNER_PROOF_PREFIX = 'swarm-connect-owner-upload:';

/**
 * The exact text an owner signs (EIP-191 `personal_sign`) to upload to
 * `stampId` without paying: `swarm-connect-owner-upload:<stamp id lowercase>:<timestamp>`.
 * `timestamp` is unix time in seconds, sent as `X-Owner-Timestamp`.
 */
export function ownerProofMessage(stampId: string, timestamp: number): string {
  return `${OWNER_PROOF_PREFIX}${stampId.toLowerCase()}:${timestamp}`;
}

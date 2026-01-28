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

/**
 * Check if a string looks like a valid Swarm reference (64 hex chars)
 */
export function isValidSwarmReference(ref: string): boolean {
  return ref.length === 64 && isValidHex(ref);
}

/**
 * Normalize a Swarm reference (lowercase, trim)
 */
export function normalizeReference(ref: string): string {
  return ref.trim().toLowerCase();
}

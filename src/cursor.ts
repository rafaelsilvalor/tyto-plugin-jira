import { base64 } from './http.js';

/**
 * Where a pull left off, handed to the host and back with the next page.
 *
 * Opaque to the host, which only compares it with the cursors it already saw, so it carries
 * what the next call cannot recompute: Jira's own token, the rows so far (for `max=`) and the
 * page number. `f` fingerprints the request the first page made, so a later page made from a
 * changed section is refused instead of stitched onto the earlier ones.
 *
 * `m` is the mapped columns' types, read off the field catalogue by the first page only. `g` is
 * the cache generation: the fill the first page came from, or the time it was read live, so a
 * later page is taken from the cache only when it belongs to the same fill. `c` says whether
 * the page before came from the cache.
 */
export interface PullCursor {
  readonly v: 1;
  /** Jira's `nextPageToken`. */
  readonly t: string;
  /** Rows answered before this page. */
  readonly n: number;
  /** The page this cursor asks for, from 2. */
  readonly p: number;
  /** {@link fingerprint} of the request. */
  readonly f: string;
  /** Each mapped column's type, by column name. */
  readonly m: Readonly<Record<string, string>>;
  /** The cache generation. */
  readonly g: number;
  /** Whether the page before came from the cache. */
  readonly c: boolean;
}

/** A cursor longer than this was not written by this plugin. */
export const MAX_CURSOR_LENGTH = 4000;

export function encodeCursor(cursor: PullCursor): string {
  return base64(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The cursor, or why it is not one this plugin gave. */
export function decodeCursor(text: string): PullCursor | string {
  if (text.length > MAX_CURSOR_LENGTH) {
    return `the cursor is ${text.length} characters long, over ${MAX_CURSOR_LENGTH}`;
  }
  const json = base64UrlText(text);
  if (json === undefined) return 'the cursor is not base64url';
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return 'the cursor is not JSON';
  }
  if (!isCursor(parsed)) return 'the cursor is not one this plugin writes';
  return parsed;
}

function isCursor(value: unknown): value is PullCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const mapped = record['m'];
  return (
    record['v'] === 1 &&
    typeof record['t'] === 'string' &&
    record['t'] !== '' &&
    Number.isSafeInteger(record['n']) &&
    (record['n'] as number) >= 0 &&
    Number.isSafeInteger(record['p']) &&
    (record['p'] as number) >= 2 &&
    typeof record['f'] === 'string' &&
    typeof mapped === 'object' &&
    mapped !== null &&
    !Array.isArray(mapped) &&
    Object.values(mapped).every((type) => typeof type === 'string') &&
    Number.isSafeInteger(record['g']) &&
    typeof record['c'] === 'boolean'
  );
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The UTF-8 text a base64url string holds, or `undefined` when it holds none. */
function base64UrlText(encoded: string): string | undefined {
  if (encoded.length % 4 === 1) return undefined;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of encoded) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) return undefined;
    buffer = ((buffer << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a, 64 bits, of the text's UTF-8, as 16 hex digits: a fingerprint, not a secret. */
export function fingerprint(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

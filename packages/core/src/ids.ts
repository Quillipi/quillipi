/**
 * Block IDs are 8 characters from a 32-letter alphabet without look-alikes (no l, o, 0, 1),
 * so they are easy to read in files and to type. That gives about a trillion values, enough
 * for people working offline to almost never collide; merges rename the rare clash.
 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

// Browsers and Node both provide this global. Declared here so core needs neither DOM nor Node types.
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

export function newId(taken?: ReadonlySet<string>): string {
  const bytes = new Uint8Array(8);
  for (;;) {
    crypto.getRandomValues(bytes);
    // 256 is a multiple of 32, so taking the remainder adds no bias.
    const id = Array.from(bytes, (byte) => ALPHABET[byte % 32]).join('');
    if (!taken?.has(id)) return id;
  }
}

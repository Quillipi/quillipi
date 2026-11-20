/** Hashes with the Web Crypto API, which browsers, Cloudflare Workers and Node all have. */
export async function digestHex(algorithm: 'SHA-1' | 'SHA-256', bytes: Uint8Array): Promise<string> {
  // Web Crypto takes bytes backed by a plain ArrayBuffer, so copy any that might not be.
  const plain = bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest(algorithm, plain));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

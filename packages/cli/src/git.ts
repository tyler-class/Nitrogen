import { createHash } from 'node:crypto';

/** Git blob SHA-1 of UTF-8 text, identical to `git hash-object`. */
export function gitBlobSha(content: string | Uint8Array): string {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const h = createHash('sha1');
  h.update(`blob ${bytes.length}\0`);
  h.update(bytes);
  return h.digest('hex');
}

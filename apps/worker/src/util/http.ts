import type { Context, MiddlewareHandler } from 'hono';

export const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
};

export function noStore(c: Context): void {
  c.header('cache-control', 'private, max-age=0, must-revalidate');
}

export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', md: 'text/markdown; charset=utf-8' } as Record<string, string>
  )[ext] ?? 'application/octet-stream';
}

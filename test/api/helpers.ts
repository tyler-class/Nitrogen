import { SELF } from 'cloudflare:test';

export const ORIGIN = 'https://nitrogen.test';
export const PASSWORD = 'correct horse battery staple';

export async function login(password = PASSWORD, ip = '203.0.113.1'): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': ip },
    body: JSON.stringify({ password }),
  });
}

export function cookieFrom(res: Response): string {
  const set = res.headers.get('Set-Cookie') ?? '';
  return set.split(';')[0]!;
}

export async function session(): Promise<Api> {
  const res = await login(PASSWORD, `198.51.100.${Math.floor(Math.random() * 200)}`);
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return new Api(cookieFrom(res));
}

export class Api {
  constructor(public cookie: string) {}
  async req<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const res = await SELF.fetch(`${ORIGIN}/api${path}`, {
      method,
      headers: {
        Cookie: this.cookie,
        Origin: ORIGIN,
        ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : method === 'GET' ? undefined : '{}',
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* csv */
    }
    return { status: res.status, data: data as T };
  }
  get<T = unknown>(path: string) {
    return this.req<T>('GET', path);
  }
  post<T = unknown>(path: string, body?: unknown) {
    return this.req<T>('POST', path, body ?? {});
  }
  patch<T = unknown>(path: string, body: unknown) {
    return this.req<T>('PATCH', path, body);
  }
  del<T = unknown>(path: string) {
    return this.req<T>('DELETE', path);
  }
}

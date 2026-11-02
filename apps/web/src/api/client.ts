export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
}

function csrf(): string {
  return /(?:^|;\s*)n2_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '';
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('content-type', 'application/json');
  if (rest.method && rest.method !== 'GET') headers.set('x-csrf-token', csrf());
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('n2:unauthorized'));
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? res.statusText, body);
  return body as T;
}

export const qs = (o: Record<string, string | number | undefined | null | string[]>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

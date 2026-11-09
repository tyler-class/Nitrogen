// Thin JSON client for the Worker API.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(
      0,
      'offline',
      'You seem to be offline. Try again when you have a connection.',
    );
  }
  const text = await res.text();
  const data: unknown = parseBody(text);
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string };
    // Logged out: tell the app, except when it's asking about the session itself (that
    // would ask again, in a loop).
    if (res.status === 401 && path !== '/login' && path !== '/session')
      unauthorizedListeners.forEach((fn) => fn());
    throw new ApiError(
      res.status,
      err.error ?? 'error',
      err.message ?? `Request failed (${res.status}).`,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/** Uploads an image as the raw request body. Resolves with ready-to-insert markdown. */
export async function uploadImage(
  file: Blob & { name?: string },
  pageId: string | null,
): Promise<import('@shared/types').UploadedFile> {
  const qs = pageId ? `?page_id=${encodeURIComponent(pageId)}` : '';
  let res: Response;
  try {
    res = await fetch(`/api/files${qs}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': file.type || 'image/png',
        'X-File-Name': encodeURIComponent(file.name ?? 'image'),
      },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'offline', 'You seem to be offline. The image was not uploaded.');
  }
  const data = parseBody(await res.text()) as { error?: string; message?: string } | null;
  if (!res.ok) {
    if (res.status === 401) unauthorizedListeners.forEach((fn) => fn());
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? 'Upload failed.');
  }
  return data as unknown as import('@shared/types').UploadedFile;
}

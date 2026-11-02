import { b64Decode, b64urlEncode, utf8 } from '../util/crypto.ts';

/** DER length encoding. */
function derLen(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, content: Uint8Array): Uint8Array {
  const len = derLen(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function cat(...xs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

/** Wrap a PKCS#1 RSAPrivateKey (what GitHub issues) in a PKCS#8 PrivateKeyInfo for WebCrypto. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  // AlgorithmIdentifier { rsaEncryption, NULL }
  const algId = der(0x30, new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]));
  return der(0x30, cat(version, algId, der(0x04, pkcs1)));
}

export function pemToDer(pem: string): { der: Uint8Array; pkcs1: boolean } {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  return { der: b64Decode(body), pkcs1 };
}

const keyCache = new Map<string, CryptoKey>();

export async function importAppKey(pem: string): Promise<CryptoKey> {
  const cached = keyCache.get(pem);
  if (cached) return cached;
  const { der: d, pkcs1 } = pemToDer(pem);
  const pkcs8 = pkcs1 ? pkcs1ToPkcs8(d) : d;
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  keyCache.set(pem, key);
  return key;
}

/** GitHub App JWT: RS256, iat backdated 60 s, exp 9 minutes ahead. */
export async function appJwt(appId: string, pem: string, nowMs = Date.now()): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const header = b64urlEncode(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = b64urlEncode(utf8(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })));
  const key = await importAppKey(pem);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(`${header}.${payload}`));
  return `${header}.${payload}.${b64urlEncode(sig)}`;
}

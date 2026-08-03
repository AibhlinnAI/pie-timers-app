/* ============================================================
   Web Push: VAPID signing (RFC 8292) + payload encryption
   (RFC 8291, aes128gcm). Implemented on WebCrypto so the edge
   function carries no third-party dependencies.
   ============================================================ */

const encoder = new TextEncoder();

/* ─────────────────────────── base64url ─────────────────────────── */

export function b64urlToBytes(input: string): Uint8Array {
  const padded = (input + "=".repeat((4 - (input.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/* ─────────────────────────── HKDF helpers ─────────────────────────── */

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

/* HKDF with a single-block expand, which is all RFC 8291 needs. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

/* ─────────────────────────── VAPID ─────────────────────────── */

/* Rebuild a JWK from the raw key pair so WebCrypto can import it.
   publicKey is the uncompressed P-256 point (0x04 || x || y). */
function vapidJwk(publicKey: Uint8Array, privateKey: Uint8Array): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point.");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(publicKey.slice(1, 33)),
    y: bytesToB64url(publicKey.slice(33, 65)),
    d: bytesToB64url(privateKey),
    ext: true,
  };
}

export async function vapidHeader(
  audience: string,
  subject: string,
  publicKeyB64: string,
  privateKeyB64: string,
): Promise<string> {
  const publicKey = b64urlToBytes(publicKeyB64);
  const privateKey = b64urlToBytes(privateKeyB64);

  const key = await crypto.subtle.importKey(
    "jwk",
    vapidJwk(publicKey, privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const header = bytesToB64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(encoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  })));

  const signingInput = encoder.encode(`${header}.${claims}`);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signingInput),
  );

  const jwt = `${header}.${claims}.${bytesToB64url(signature)}`;
  return `vapid t=${jwt}, k=${publicKeyB64}`;
}

/* ─────────────────────────── Payload encryption ─────────────────────────── */

export async function encryptPayload(
  plaintext: string,
  clientPublicKeyB64: string,
  authSecretB64: string,
): Promise<Uint8Array> {
  const clientPublic = b64urlToBytes(clientPublicKeyB64);
  const authSecret = b64urlToBytes(authSecretB64);

  // Ephemeral sender key pair, fresh for every message.
  const senderPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair;

  const senderPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", senderPair.publicKey),
  );

  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientKey },
      senderPair.privateKey,
      256,
    ),
  );

  // IKM binds the shared secret to both parties' public keys.
  const keyInfo = concat(
    encoder.encode("WebPush: info\0"),
    clientPublic,
    senderPublic,
  );
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  // 0x02 is the final-record padding delimiter.
  const padded = concat(encoder.encode(plaintext), new Uint8Array([2]));

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded),
  );

  // Header: salt(16) | record size(4, BE) | key id length(1) | key id(65)
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);

  return concat(
    salt,
    recordSize,
    new Uint8Array([senderPublic.length]),
    senderPublic,
    ciphertext,
  );
}

/* ─────────────────────────── Send ─────────────────────────── */

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface SendResult {
  ok: boolean;
  status: number;
  /* True when the endpoint is permanently dead and should be deleted. */
  gone: boolean;
}

export async function sendPush(
  subscription: PushSubscription,
  payload: unknown,
  vapid: { publicKey: string; privateKey: string; subject: string },
  ttlSeconds = 900,
): Promise<SendResult> {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;

  const authorization = await vapidHeader(
    audience,
    vapid.subject,
    vapid.publicKey,
    vapid.privateKey,
  );

  const body = await encryptPayload(
    JSON.stringify(payload),
    subscription.keys.p256dh,
    subscription.keys.auth,
  );

  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSeconds),
    },
    body,
  });

  return {
    ok: response.ok,
    status: response.status,
    // 404/410 mean the browser dropped the subscription for good.
    gone: response.status === 404 || response.status === 410,
  };
}

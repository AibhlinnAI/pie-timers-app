/* ============================================================
   Firebase Cloud Messaging (HTTP v1), for the Android app.

   The Play app is a WebView, and a WebView has no Web Push. So the
   app registers a Firebase device token instead, and it is stored in
   push_subscriptions beside the browsers, as the endpoint
   "fcm:<token>" with empty keys. This file sends to one of those.

   Google's API wants a short-lived access token, bought with a JWT
   signed by the Firebase service account (RS256). Implemented on
   WebCrypto, like webpush.ts, so the function still carries no
   third-party dependencies.

   The service account is the FCM_SERVICE_ACCOUNT secret: the whole
   JSON key file Firebase hands out, as one string. Without it this
   file sends nothing and says so once per run; browsers are not
   affected.
   ============================================================ */

import { bytesToB64url, type SendResult } from "./webpush.ts";

const encoder = new TextEncoder();

const FCM_PREFIX = "fcm:";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/* A milestone alert is about the next few minutes. One that could not
   be delivered within this long is dropped by Google rather than shown
   late: "5 minutes left" arriving after the bell is worse than nothing. */
const TTL_SECONDS = 240;

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface FcmMessage {
  title: string;
  body: string;
  tag: string;
}

/* Whether a push_subscriptions row is an Android device token. */
export function isFcmEndpoint(endpoint: string | null | undefined): boolean {
  return typeof endpoint === "string" && endpoint.startsWith(FCM_PREFIX) &&
    endpoint.length > FCM_PREFIX.length;
}

export function fcmToken(endpoint: string): string {
  return endpoint.slice(FCM_PREFIX.length);
}

/* The secret as an object, or null when it is missing or is not a
   service account key. Never throws: a bad secret must not take the
   browsers' pushes down with it. */
export function parseServiceAccount(raw: string | null | undefined): ServiceAccount | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.project_id === "string" && parsed.project_id &&
      typeof parsed?.client_email === "string" && parsed.client_email &&
      typeof parsed?.private_key === "string" && parsed.private_key.includes("PRIVATE KEY")
    ) {
      return {
        project_id: parsed.project_id,
        client_email: parsed.client_email,
        private_key: parsed.private_key,
      };
    }
  } catch (_) {
    // falls through
  }
  return null;
}

/* ─────────────────────────── Access token ─────────────────────────── */

function pemToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function jsonB64url(value: unknown): string {
  return bytesToB64url(encoder.encode(JSON.stringify(value)));
}

async function signedJwt(account: ServiceAccount, nowSec: number): Promise<string> {
  const header = jsonB64url({ alg: "RS256", typ: "JWT" });
  const claims = jsonB64url({
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  });
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${claims}`)),
  );
  return `${header}.${claims}.${bytesToB64url(signature)}`;
}

/* One access token serves every send for most of an hour. The function
   runs each minute and an instance often lives across runs, so it is
   kept, keyed by the account it was bought for, and renewed five
   minutes early. */
let cached: { email: string; token: string; expiresAt: number } | null = null;

async function accessToken(account: ServiceAccount): Promise<string> {
  const now = Date.now();
  if (cached && cached.email === account.client_email && cached.expiresAt - now > 5 * 60 * 1000) {
    return cached.token;
  }

  const assertion = await signedJwt(account, Math.floor(now / 1000));
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`FCM access token refused: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  if (typeof body?.access_token !== "string") throw new Error("FCM access token missing from reply.");

  cached = {
    email: account.client_email,
    token: body.access_token,
    expiresAt: now + (Number(body.expires_in) || 3600) * 1000,
  };
  return cached.token;
}

/* ─────────────────────────── Send ─────────────────────────── */

/* A data message, not a "notification" one: the app's own service
   builds the notification (PushService.java), so it carries the tag
   that lets it stand in for the in-app alert for the same milestone,
   and looks the same whether the app is open, in the background or
   closed. High priority is what gets it through while the phone dozes.

   `gone` means Google no longer knows the token (the app was removed,
   or its data cleared), and the caller deletes the row. Only 404 says
   that. A 400 can be this function's own mistake, and must not delete
   a working device. */
export async function sendFcm(
  token: string,
  message: FcmMessage,
  account: ServiceAccount,
): Promise<SendResult> {
  const bearer = await accessToken(account);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token,
          data: { title: message.title, body: message.body, tag: message.tag },
          android: { priority: "HIGH", ttl: `${TTL_SECONDS}s` },
        },
      }),
    },
  );

  /* An access token Google has stopped honouring: forget it, so the
     next run buys a new one instead of failing for the rest of the hour. */
  if (response.status === 401) cached = null;
  if (!response.ok) await response.text().catch(() => "");

  return {
    ok: response.ok,
    status: response.status,
    gone: response.status === 404,
  };
}

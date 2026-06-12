// Telegram Mini App initData validation.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// secret_key = HMAC_SHA256(bot_token, key="WebAppData")
// hash       = hex(HMAC_SHA256(data_check_string, key=secret_key))
// data_check_string = sorted "key=value" pairs (all fields except hash), joined by "\n".

const encoder = new TextEncoder();

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface InitDataUser {
  id: number;
  first_name: string;
  username?: string;
}

const MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Verifies the HMAC signature and freshness of Mini App initData.
 * Returns the authenticated Telegram user, or null if invalid.
 */
export async function validateInitData(
  initData: string,
  botToken: string,
): Promise<InitDataUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");

  const secretKey = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const expected = toHex(await hmacSha256(secretKey, dataCheckString));
  if (expected !== hash) return null;

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > MAX_AGE_SECONDS) return null;

  const rawUser = params.get("user");
  if (!rawUser) return null;
  try {
    const user = JSON.parse(rawUser) as InitDataUser;
    if (typeof user.id !== "number" || typeof user.first_name !== "string") return null;
    return user;
  } catch {
    return null;
  }
}

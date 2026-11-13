import { config } from "../config.js";

const DEFAULT_SCOPE = "accounting.transactions accounting.settings";
const cache = new Map<string, { token: string; expiresAt: number }>();

export async function getXeroToken(scope: string = DEFAULT_SCOPE): Promise<string> {
  const cached = cache.get(scope);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  if (!config.XERO_CLIENT_ID || !config.XERO_CLIENT_SECRET) {
    throw new Error("XERO_CLIENT_ID / XERO_CLIENT_SECRET missing from .env.local");
  }

  const basic = Buffer.from(`${config.XERO_CLIENT_ID}:${config.XERO_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope,
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(`Xero token request failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  const entry = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  cache.set(scope, entry);
  return entry.token;
}

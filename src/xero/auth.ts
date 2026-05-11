import { config } from "../config.js";

let cached: { token: string; expiresAt: number } | null = null;

export async function getXeroToken(): Promise<string> {
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
      scope: "accounting.transactions accounting.settings",
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(`Xero token request failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

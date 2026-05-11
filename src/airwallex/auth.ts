import { config } from "../config.js";

let cached: { token: string; expiresAt: number } | null = null;

export async function getAirwallexToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(`${config.AIRWALLEX_BASE_URL}/api/v1/authentication/login`, {
    method: "POST",
    headers: {
      "x-client-id": config.AIRWALLEX_CLIENT_ID,
      "x-api-key": config.AIRWALLEX_API_KEY,
    },
  });

  if (!res.ok) {
    throw new Error(`Airwallex auth failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { token: string; expires_at: string };
  cached = { token: body.token, expiresAt: new Date(body.expires_at).getTime() };
  return cached.token;
}

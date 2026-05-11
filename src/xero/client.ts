import { config } from "../config.js";
import { getXeroToken } from "./auth.js";

const BASE = "https://api.xero.com/api.xro/2.0";

export async function xeroGet<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  if (!config.XERO_TENANT_ID) throw new Error("XERO_TENANT_ID missing");
  const token = await getXeroToken();
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Xero-Tenant-Id": config.XERO_TENANT_ID,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Xero GET ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function xeroPost<T>(path: string, body: unknown): Promise<T> {
  if (!config.XERO_TENANT_ID) throw new Error("XERO_TENANT_ID missing");
  const token = await getXeroToken();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Xero-Tenant-Id": config.XERO_TENANT_ID,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Xero POST ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface XeroAccount {
  AccountID: string;
  Code?: string;
  Name: string;
  Type: string;
  BankAccountNumber?: string;
  CurrencyCode?: string;
  Status: string;
}

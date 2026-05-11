import { xeroGet, type XeroAccount } from "./client.js";
import { db } from "../db/db.js";

const upsertWallet = db.prepare(`
  INSERT INTO wallets (currency, xero_account_code, xero_account_id)
  VALUES (@currency, @xero_account_code, @xero_account_id)
  ON CONFLICT(currency) DO UPDATE SET
    xero_account_code = excluded.xero_account_code,
    xero_account_id = excluded.xero_account_id
`);

const BANK_NAME_RE = /^AWX_.*_Cash_([A-Z]{3})$/;

export async function listBankAccounts(): Promise<XeroAccount[]> {
  const res = await xeroGet<{ Accounts: XeroAccount[] }>("/Accounts", {
    where: 'Type=="BANK"',
  });
  return res.Accounts ?? [];
}

export async function discoverAwxWallets(): Promise<Array<{ currency: string; account: XeroAccount }>> {
  const banks = await listBankAccounts();
  const matches: Array<{ currency: string; account: XeroAccount }> = [];
  for (const acc of banks) {
    const m = acc.Name.match(BANK_NAME_RE);
    if (!m) continue;
    const currency = m[1]!;
    matches.push({ currency, account: acc });
    upsertWallet.run({
      currency,
      xero_account_code: acc.Code ?? null,
      xero_account_id: acc.AccountID,
    });
  }
  return matches;
}

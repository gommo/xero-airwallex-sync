import { xeroGet } from "../src/xero/client.js";

interface TaxRate {
  Name: string;
  TaxType: string;
  ReportTaxType?: string;
  Status: string;
  EffectiveRate?: number;
  CanApplyToExpenses?: boolean;
}

const res = await xeroGet<{ TaxRates: TaxRate[] }>("/TaxRates");
for (const t of res.TaxRates ?? []) {
  if (t.Status !== "ACTIVE") continue;
  if (t.CanApplyToExpenses === false) continue;
  console.log(`${t.TaxType.padEnd(20)} ${String(t.EffectiveRate ?? "").padEnd(6)} ${t.Name}`);
}

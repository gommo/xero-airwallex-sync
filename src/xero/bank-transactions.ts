import { xeroPost } from "./client.js";
import type { PlannedPosting } from "../sync/plan.js";

interface BankTransactionResponse {
  BankTransactions: Array<{
    BankTransactionID: string;
    Reference: string;
    Status: string;
  }>;
}

function buildBody(plan: PlannedPosting, includeId?: string) {
  if (!plan.xero_account_code) {
    throw new Error(
      `No account code for ${plan.reference}. Set XERO_EXPENSE_CODE/XERO_REVENUE_CODE in .env.local or add a merchant mapping.`,
    );
  }
  return {
    BankTransactions: [
      {
        ...(includeId ? { BankTransactionID: includeId } : {}),
        Type: plan.kind,
        Contact: { Name: plan.contact_name },
        LineItems: [
          {
            Description: plan.description,
            Quantity: 1,
            UnitAmount: Math.abs(plan.aud_amount),
            AccountCode: plan.xero_account_code,
            TaxType: "EXEMPTEXPENSES",
          },
        ],
        BankAccount: { AccountID: plan.xero_account_id },
        Date: plan.date,
        Reference: plan.reference,
        Status: "AUTHORISED",
        LineAmountTypes: "Inclusive",
        IsReconciled: false,
      },
    ],
  };
}

export async function postBankTransaction(plan: PlannedPosting): Promise<string> {
  const res = await xeroPost<BankTransactionResponse>("/BankTransactions", buildBody(plan));
  const id = res.BankTransactions?.[0]?.BankTransactionID;
  if (!id) throw new Error(`Xero returned no BankTransactionID for ${plan.reference}`);
  return id;
}

export async function updateBankTransaction(xeroId: string, plan: PlannedPosting): Promise<void> {
  await xeroPost<BankTransactionResponse>("/BankTransactions", buildBody(plan, xeroId));
}

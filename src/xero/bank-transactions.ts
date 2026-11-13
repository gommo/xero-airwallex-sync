import { xeroPost, xeroPut } from "./client.js";
import type { PlannedPosting } from "../sync/plan.js";

interface BankTransactionResponse {
  BankTransactions: Array<{
    BankTransactionID: string;
    Reference: string;
    Status: string;
  }>;
}

function buildBody(plan: PlannedPosting, includeId?: string) {
  if (plan.kind === "TRANSFER") throw new Error(`${plan.reference} is a transfer; use postBankTransfer`);
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
            TaxType: plan.tax_type ?? "EXEMPTEXPENSES",
            // Omit Tracking entirely when we have none, so updating an unmapped row
            // doesn't wipe tracking a user set manually in the Xero UI.
            ...(plan.tracking.length
              ? {
                  Tracking: plan.tracking.map((t) => ({
                    TrackingCategoryID: t.categoryId,
                    TrackingOptionID: t.optionId,
                  })),
                }
              : {}),
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

interface BankTransferResponse {
  BankTransfers: Array<{ BankTransferID: string }>;
}

/** Move money between two Xero bank accounts (creates both sides in one go). */
export async function postBankTransfer(plan: PlannedPosting): Promise<string> {
  if (!plan.xero_account_id || !plan.to_account_id) {
    throw new Error(`Transfer ${plan.reference} is missing a from/to bank account`);
  }
  const res = await xeroPut<BankTransferResponse>("/BankTransfers", {
    BankTransfers: [
      {
        FromBankAccount: { AccountID: plan.xero_account_id },
        ToBankAccount: { AccountID: plan.to_account_id },
        Amount: Math.abs(plan.aud_amount).toFixed(2),
        Date: plan.date,
        Reference: plan.reference,
      },
    ],
  });
  const id = res.BankTransfers?.[0]?.BankTransferID;
  if (!id) throw new Error(`Xero returned no BankTransferID for ${plan.reference}`);
  return id;
}

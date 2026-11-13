import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: ".env.local" });

const schema = z.object({
  AIRWALLEX_CLIENT_ID: z.string().min(1, "missing AIRWALLEX_CLIENT_ID in .env.local"),
  AIRWALLEX_API_KEY: z.string().min(1, "missing AIRWALLEX_API_KEY in .env.local"),
  AIRWALLEX_BASE_URL: z.string().url().default("https://api.airwallex.com"),
  STRIPE_API_READONLY_KEY: z.string().optional(),
  STRIPE_BASE_URL: z.string().url().default("https://api.stripe.com"),
  // Xero posting targets for the Stripe planner (ids from the OWR Xero org).
  STRIPE_BANK_ACCOUNT_ID: z.string().optional(),
  STRIPE_TRACKING_CATEGORY_ID: z.string().optional(),
  STRIPE_TRACKING_OPTION_ID: z.string().optional(),
  STRIPE_CODE_SUBSCRIPTIONS: z.string().optional(),
  STRIPE_CODE_SPONSORSHIP: z.string().optional(),
  STRIPE_CODE_TICKETING: z.string().optional(),
  STRIPE_CODE_FEES: z.string().optional(),
  STRIPE_CODE_CLEARING: z.string().optional(),
  STRIPE_CODE_RESERVE: z.string().optional(),
  // Rate difference when Stripe converts a foreign balance to AUD (falls back to the fees code).
  STRIPE_CODE_FX: z.string().optional(),
  STRIPE_SPONSORSHIP_PRODUCT_ID: z.string().optional(),
  // PayPal Transaction Search (Live REST app with "Transaction Search" enabled).
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_BASE_URL: z.string().url().default("https://api-m.paypal.com"),
  // PayPal -> Xero posting targets (Tributech org): the AUD-denominated
  // "Paypal USD (Manual)" bank account, the Patreon revenue code, tracking.
  PAYPAL_BANK_ACCOUNT_ID: z.string().optional(),
  PAYPAL_PATREON_CODE: z.string().optional(),
  PAYPAL_TRACKING_CATEGORY_ID: z.string().optional(),
  PAYPAL_TRACKING_OPTION_ID: z.string().optional(),
  // Date floor (YYYY-MM-DD): payouts before this were keyed by hand; never re-post them.
  PAYPAL_POST_FROM: z.string().optional(),
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  XERO_TENANT_ID: z.string().optional(),
  XERO_EXPENSE_CODE: z.string().optional(),
  XERO_REVENUE_CODE: z.string().optional(),
  DB_PATH: z.string().default("./data/sync.db"),
  LOG_LEVEL: z.string().default("info"),
});

export const config = schema.parse(process.env);

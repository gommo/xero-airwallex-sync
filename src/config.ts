import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: ".env.local" });

const schema = z.object({
  AIRWALLEX_CLIENT_ID: z.string().min(1, "missing AIRWALLEX_CLIENT_ID in .env.local"),
  AIRWALLEX_API_KEY: z.string().min(1, "missing AIRWALLEX_API_KEY in .env.local"),
  AIRWALLEX_BASE_URL: z.string().url().default("https://api.airwallex.com"),
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  XERO_TENANT_ID: z.string().optional(),
  XERO_EXPENSE_CODE: z.string().optional(),
  XERO_REVENUE_CODE: z.string().optional(),
  DB_PATH: z.string().default("./data/sync.db"),
  LOG_LEVEL: z.string().default("info"),
});

export const config = schema.parse(process.env);

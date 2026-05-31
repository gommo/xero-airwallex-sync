import { xeroGet } from "./client.js";
import { db } from "../db/db.js";

interface XeroOption {
  TrackingOptionID: string;
  Name: string;
  Status: string;
}
interface XeroCategory {
  TrackingCategoryID: string;
  Name: string;
  Status: string;
  Options?: XeroOption[];
}

const upsertCat = db.prepare(`
  INSERT INTO xero_tracking_categories (id, name, status)
  VALUES (@id, @name, @status)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status, fetched_at=datetime('now')
`);
const upsertOpt = db.prepare(`
  INSERT INTO xero_tracking_options (id, category_id, name, status)
  VALUES (@id, @category_id, @name, @status)
  ON CONFLICT(id) DO UPDATE SET category_id=excluded.category_id, name=excluded.name, status=excluded.status, fetched_at=datetime('now')
`);

export async function refreshTracking(): Promise<{ categories: number; options: number }> {
  const res = await xeroGet<{ TrackingCategories: XeroCategory[] }>("/TrackingCategories");
  let cats = 0;
  let opts = 0;
  db.transaction(() => {
    for (const c of res.TrackingCategories ?? []) {
      upsertCat.run({ id: c.TrackingCategoryID, name: c.Name, status: c.Status });
      cats += 1;
      for (const o of c.Options ?? []) {
        upsertOpt.run({ id: o.TrackingOptionID, category_id: c.TrackingCategoryID, name: o.Name, status: o.Status });
        opts += 1;
      }
    }
  })();
  return { categories: cats, options: opts };
}

export interface TrackingCategoryRow {
  id: string;
  name: string;
  status: string | null;
}
export interface TrackingOptionRow {
  id: string;
  category_id: string;
  name: string;
  status: string | null;
}

export function listCategories(): TrackingCategoryRow[] {
  return db.prepare("SELECT id, name, status FROM xero_tracking_categories ORDER BY name").all() as TrackingCategoryRow[];
}
export function listOptions(categoryId?: string): TrackingOptionRow[] {
  if (categoryId) {
    return db
      .prepare("SELECT id, category_id, name, status FROM xero_tracking_options WHERE category_id = ? ORDER BY name")
      .all(categoryId) as TrackingOptionRow[];
  }
  return db.prepare("SELECT id, category_id, name, status FROM xero_tracking_options ORDER BY name").all() as TrackingOptionRow[];
}

export interface ResolvedTracking {
  categoryId: string;
  categoryName: string;
  optionId: string;
  optionName: string;
}

/**
 * Resolve a "Category:Option" string (case-insensitive) to Xero IDs from the
 * local cache. If only "Option" is given and it's unambiguous across categories,
 * that works too. Throws with a helpful message if not found / ambiguous.
 */
export function resolveTrackingSpec(spec: string): ResolvedTracking {
  const parts = spec.split(":");
  const hasCat = parts.length >= 2;
  const catName = hasCat ? parts[0]!.trim() : null;
  const optName = (hasCat ? parts.slice(1).join(":") : parts[0]!).trim();

  const cats = listCategories();
  if (cats.length === 0) {
    throw new Error("No tracking categories cached. Run `pnpm sync tracking refresh` first.");
  }

  let candidateCats = cats;
  if (catName) {
    candidateCats = cats.filter((c) => c.name.toLowerCase() === catName.toLowerCase());
    if (candidateCats.length === 0) {
      throw new Error(`Tracking category "${catName}" not found. Categories: ${cats.map((c) => c.name).join(", ")}`);
    }
  }

  const matches: ResolvedTracking[] = [];
  for (const c of candidateCats) {
    for (const o of listOptions(c.id)) {
      if (o.status !== "ACTIVE") continue;
      if (o.name.toLowerCase() === optName.toLowerCase()) {
        matches.push({ categoryId: c.id, categoryName: c.name, optionId: o.id, optionName: o.name });
      }
    }
  }

  if (matches.length === 0) {
    const avail = candidateCats
      .map((c) => `${c.name}: ${listOptions(c.id).filter((o) => o.status === "ACTIVE").map((o) => o.name).join(", ")}`)
      .join(" | ");
    throw new Error(`Tracking option "${optName}" not found. Available — ${avail}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Tracking option "${optName}" is ambiguous across categories: ${matches.map((m) => m.categoryName).join(", ")}. Use Category:Option form.`,
    );
  }
  return matches[0]!;
}

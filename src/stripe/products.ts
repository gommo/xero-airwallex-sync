import { stripeGet, stripeList, type StripeList } from "./client.js";

export interface ProductRef {
  product_id: string;
  product_name: string;
}

interface PriceObj {
  id: string;
  currency: string;
  unit_amount: number | null;
  product: string | { id: string; name?: string };
}

interface SubItem {
  price: PriceObj;
}
interface Subscription {
  id: string;
  items: { data: SubItem[] };
}
interface CheckoutSession {
  id: string;
  line_items?: { data: Array<{ price: PriceObj }> };
}

interface ChargeLike {
  currency: string;
  amount: number;
  customer?: string | { id: string } | null;
  payment_intent?: string | { id: string } | null;
}

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}
function productIdOf(p: PriceObj["product"]): string {
  return typeof p === "string" ? p : p.id;
}

/**
 * Resolves the Stripe product behind a charge, authoritatively and without
 * relying on hardcoded amounts:
 *  - subscription charges -> the customer's actual subscription item's product
 *  - one-off (payment-link) charges -> the checkout session's line-item product
 * Falls back to a (currency, unit_amount) catalogue lookup only when neither is
 * available. Re-pulling the catalogue each run means new currencies/prices added
 * at launch are picked up automatically.
 */
export class ProductResolver {
  private productNames = new Map<string, string>();
  private amountToProducts = new Map<string, Set<string>>(); // "ccy:amount" -> productIds
  private customerCache = new Map<string, ProductRef[]>();
  private sessionCache = new Map<string, ProductRef | null>();

  async loadCatalogue(): Promise<void> {
    for await (const p of stripeList<PriceObj>("/prices", { expand: ["data.product"] })) {
      const pid = productIdOf(p.product);
      if (typeof p.product !== "string" && p.product.name) this.productNames.set(pid, p.product.name);
      if (p.unit_amount != null) {
        const key = `${p.currency}:${p.unit_amount}`;
        (this.amountToProducts.get(key) ?? this.amountToProducts.set(key, new Set()).get(key)!).add(pid);
      }
    }
  }

  private ref(productId: string): ProductRef {
    return { product_id: productId, product_name: this.productNames.get(productId) ?? `(product ${productId})` };
  }

  /** Like ref(), but fetches the product name if not already cached (e.g. ad-hoc
   *  checkout products that never appear in the price catalogue). */
  private async namedRef(productId: string): Promise<ProductRef> {
    if (!this.productNames.has(productId)) {
      try {
        const p = await stripeGet<{ id: string; name?: string }>(`/products/${productId}`, {});
        if (p.name) this.productNames.set(productId, p.name);
      } catch {
        /* leave unnamed */
      }
    }
    return this.ref(productId);
  }

  private async customerProducts(customer: string): Promise<ProductRef[]> {
    const cached = this.customerCache.get(customer);
    if (cached) return cached;
    const list = await stripeGet<StripeList<Subscription>>("/subscriptions", {
      customer,
      status: "all",
      limit: 100,
      expand: ["data.items.data.price"],
    });
    const seen = new Map<string, ProductRef>();
    for (const sub of list.data) {
      for (const item of sub.items.data) {
        const pid = productIdOf(item.price.product);
        if (item.price.unit_amount != null) {
          const key = `${item.price.currency}:${item.price.unit_amount}`;
          (this.amountToProducts.get(key) ?? this.amountToProducts.set(key, new Set()).get(key)!).add(pid);
        }
        if (typeof item.price.product !== "string" && item.price.product.name) {
          this.productNames.set(pid, item.price.product.name);
        }
        seen.set(pid, this.ref(pid));
      }
    }
    const refs = [...seen.values()];
    this.customerCache.set(customer, refs);
    return refs;
  }

  private async sessionProduct(paymentIntent: string): Promise<ProductRef | null> {
    if (this.sessionCache.has(paymentIntent)) return this.sessionCache.get(paymentIntent)!;
    const sessions = await stripeGet<StripeList<CheckoutSession>>("/checkout/sessions", {
      payment_intent: paymentIntent,
      expand: ["data.line_items"],
    });
    let ref: ProductRef | null = null;
    for (const s of sessions.data) {
      for (const li of s.line_items?.data ?? []) {
        ref = this.ref(productIdOf(li.price.product));
        break;
      }
      if (ref) break;
    }
    this.sessionCache.set(paymentIntent, ref);
    return ref;
  }

  private amountMatch(currency: string, amount: number, restrictTo?: Set<string>): ProductRef | null {
    const pids = this.amountToProducts.get(`${currency}:${amount}`);
    if (!pids || pids.size === 0) return null;
    const candidates = restrictTo ? [...pids].filter((p) => restrictTo.has(p)) : [...pids];
    return candidates.length ? this.ref(candidates[0]!) : null;
  }

  async resolve(charge: ChargeLike): Promise<ProductRef | null> {
    const customer = idOf(charge.customer);
    if (customer) {
      const prods = await this.customerProducts(customer);
      if (prods.length === 1) return prods[0]!;
      if (prods.length > 1) {
        const set = new Set(prods.map((p) => p.product_id));
        return this.amountMatch(charge.currency, charge.amount, set) ?? prods[0]!;
      }
    }
    const pi = idOf(charge.payment_intent);
    if (pi) {
      const r = await this.sessionProduct(pi);
      if (r) return r;
    }
    return this.amountMatch(charge.currency, charge.amount);
  }
}

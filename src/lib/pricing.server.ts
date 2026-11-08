import type { Transaction } from "./db";
export async function resolvePrice(
  tx: Transaction,
  restaurantId: string,
  productId: string,
  billingUnit: string,
): Promise<string | null> {
  const result = await tx.query<{ amount: string }>(
    "SELECT coalesce((SELECT amount FROM restaurant_prices WHERE restaurant_id=$1 AND product_id=$2 AND billing_unit=$3),(SELECT amount FROM prices WHERE product_id=$2 AND billing_unit=$3))::text amount",
    [restaurantId, productId, billingUnit],
  );
  return result.rows[0]?.amount ?? null;
}

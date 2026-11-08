"use client";
import { useState } from "react";
import { money, type Product, type Unit } from "@/lib/domain";
import type { ViewProps } from "./types";
import { Field, Modal, ErrorText } from "./ui";
export function ThresholdSettings({ data, mutate, busy, error }: ViewProps) {
  const [small, setSmall] = useState(data.shop.small_weight_percent);
  const [large, setLarge] = useState(data.shop.large_weight_percent);
  return (
    <section className="panel">
      <h2>重量差异阈值</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await mutate(
            { action: "saveThresholds", small, large },
            "差异阈值已保存",
          );
        }}
      >
        <div className="two-columns">
          <Field label="订购少于 500g（%）">
            <input
              inputMode="decimal"
              value={small}
              onChange={(e) => setSmall(e.target.value)}
              required
            />
          </Field>
          <Field label="订购 500g 及以上（%）">
            <input
              inputMode="decimal"
              value={large}
              onChange={(e) => setLarge(e.target.value)}
              required
            />
          </Field>
        </div>
        <p className="fine-print">
          超过阈值才警告；修改阈值后，未定稿订单会重新核对。
        </p>
        <ErrorText message={error} />
        <button className="primary" disabled={busy}>
          保存阈值
        </button>
      </form>
    </section>
  );
}
export function RestaurantPrices({ data, mutate, busy, error }: ViewProps) {
  const [restaurantId, setRestaurantId] = useState("");
  const [filter, setFilter] = useState("");
  const [edit, setEdit] = useState<{
    product: Product;
    unit: Unit;
    value: string;
    version: number;
  } | null>(null);
  return (
    <>
      <Field label="餐馆">
        <select
          value={restaurantId}
          onChange={(e) => setRestaurantId(e.target.value)}
        >
          <option value="">请选择餐馆</option>
          {data.restaurants
            .filter((r) => r.active)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </Field>
      {restaurantId && (
        <>
          <input
            type="search"
            aria-label="搜索专价商品"
            placeholder="搜索商品"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="catalog-list">
            {data.products
              .filter(
                (p) =>
                  p.active &&
                  p.name.toLowerCase().includes(filter.toLowerCase()),
              )
              .flatMap((p) =>
                [...new Set(p.units.map((u) => u.billingUnit))].map((unit) => {
                  const override = data.restaurantPrices.find(
                    (o) =>
                      o.restaurant_id === restaurantId &&
                      o.product_id === p.id &&
                      o.billing_unit === unit,
                  );
                  const standard =
                    p.units.find((u) => u.billingUnit === unit)?.price ?? null;
                  return (
                    <article className="catalog-row" key={`${p.id}:${unit}`}>
                      <div className="catalog-content">
                        <h3>
                          {p.name} / {unit}
                        </h3>
                        <p>
                          {override
                            ? `餐馆专价 ${money(override.amount)}`
                            : `标准价 ${money(standard)}`}
                        </p>
                      </div>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          setEdit({
                            product: p,
                            unit,
                            value: override?.amount ?? "",
                            version: override?.version ?? 0,
                          })
                        }
                      >
                        设专价
                      </button>
                    </article>
                  );
                }),
              )}
          </div>
        </>
      )}
      {edit && (
        <Modal
          title="餐馆专价"
          onClose={() => {
            if (!busy) setEdit(null);
          }}
        >
          <h3>
            {data.restaurants.find((r) => r.id === restaurantId)?.name} ·{" "}
            {edit.product.name}
          </h3>
          <Field
            label={`每 ${edit.unit} 售价（RM）`}
            hint="留空则恢复标准价。已确认订单的快照不会自动改变。"
          >
            <input
              inputMode="decimal"
              value={edit.value}
              onChange={(e) => setEdit({ ...edit, value: e.target.value })}
            />
          </Field>
          <ErrorText message={error} />
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setEdit(null)}
            >
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                if (
                  await mutate(
                    {
                      action: "saveRestaurantPrice",
                      restaurantId,
                      productId: edit.product.id,
                      billingUnit: edit.unit,
                      price: edit.value || null,
                      expectedVersion: edit.version,
                    },
                    "餐馆价格已保存",
                  )
                )
                  setEdit(null);
              }}
            >
              保存
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

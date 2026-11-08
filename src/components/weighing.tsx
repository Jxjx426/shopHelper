"use client";
import { allowed } from "@/lib/permissions";
import { useCallback, useEffect, useRef, useState } from "react";
import Decimal from "decimal.js";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Scale,
  RefreshCw,
  PackageX,
} from "lucide-react";
import {
  billedResolved,
  isWeight,
  lineAmount,
  money,
  pickedResolved,
  subtotal,
  type OrderItem,
  type Unit,
  type Workspace,
} from "@/lib/domain";
import { Empty, ErrorText, Field, Modal, Progress } from "./ui";
import type { Mutate, ViewProps } from "./types";
import { discrepancy } from "@/lib/billing";
import Documents from "./documents";

function ActualItem({
  item,
  product,
  data,
  mutate,
  busy,
  onNext,
  error,
  readOnly = false,
  onDirtyChange,
}: {
  item: OrderItem;
  product: string;
  data: Workspace;
  mutate: Mutate;
  busy: boolean;
  onNext: () => void;
  error?: string;
  readOnly?: boolean;
  onDirtyChange: (id: string, dirty: boolean) => void;
}) {
  const [actual, setActual] = useState(
    item.actual_quantity
      ? new Decimal(item.actual_quantity).toString()
      : isWeight(item.billing_unit)
        ? ""
        : new Decimal(item.ordered_quantity).toString(),
  );
  const [unit, setUnit] = useState<Unit>(
    item.actual_unit ??
      (isWeight(item.billing_unit) ? "kg" : item.billing_unit),
  );
  const [dirty, setDirty] = useState(false);
  const [baseVersion, setBaseVersion] = useState(item.version);
  const [localError, setLocalError] = useState("");
  const [failedSave, setFailedSave] = useState(false);
  const [refreshPrice, setRefreshPrice] = useState(false);
  const [unavailable, setUnavailable] = useState<{
    version: number;
    taskVersion: number;
  } | null>(null);
  const [warningNext, setWarningNext] = useState<boolean | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const localKey = `fresh-helper-actual:${data.generation}:${data.user?.id ?? "owner"}:${item.id}`;
  useEffect(() => {
    onDirtyChange(item.id, dirty);
    return () => onDirtyChange(item.id, false);
  }, [item.id, dirty, onDirtyChange]);
  useEffect(() => {
    if (readOnly) return;
    try {
      const legacyKey = `fresh-helper-actual:${item.id}`;
      const raw =
        localStorage.getItem(localKey) ??
        (allowed(data.user, "manage") ? localStorage.getItem(legacyKey) : null);
      if (raw && !localStorage.getItem(localKey)) {
        localStorage.setItem(localKey, raw);
        localStorage.removeItem(legacyKey);
      }
      if (raw) {
        const draft = JSON.parse(raw);
        if (
          Number.isInteger(draft.version) &&
          typeof draft.actual === "string" &&
          typeof draft.unit === "string"
        ) {
          setActual(draft.actual);
          setUnit(draft.unit);
          setDirty(true);
          setBaseVersion(draft.version);
        }
      }
    } catch {
      /* Keep the saved server value if local draft is invalid. */
    }
  }, [localKey, readOnly]);
  useEffect(() => {
    if (!dirty && item.version !== baseVersion) {
      setActual(
        item.actual_quantity
          ? new Decimal(item.actual_quantity).toString()
          : isWeight(item.billing_unit)
            ? ""
            : new Decimal(item.ordered_quantity).toString(),
      );
      setUnit(
        item.actual_unit ??
          (isWeight(item.billing_unit) ? "kg" : item.billing_unit),
      );
      setBaseVersion(item.version);
    }
  }, [
    item.version,
    item.actual_quantity,
    item.actual_unit,
    item.billing_unit,
    item.ordered_quantity,
    dirty,
    baseVersion,
  ]);
  useEffect(() => {
    if (dirty) {
      try {
        localStorage.setItem(
          localKey,
          JSON.stringify({ actual, unit, version: baseVersion }),
        );
      } catch {
        setLocalError("本机未能保留输入，请保持页面打开直到保存成功。");
      }
    }
  }, [actual, unit, dirty, localKey, baseVersion]);
  let preview: string | null = null;
  try {
    if (
      actual.trim() &&
      item.price_snapshot !== null &&
      new Decimal(actual).gte(0)
    )
      preview = lineAmount(
        actual,
        unit,
        item.billing_unit,
        item.price_snapshot,
      );
  } catch {
    /* The server validates on save. */
  }
  const restaurantId = data.orders.find(
    (o) => o.id === item.order_id,
  )?.restaurant_id;
  const currentPrice =
    data.restaurantPrices.find(
      (p) =>
        p.restaurant_id === restaurantId &&
        p.product_id === item.product_id &&
        p.billing_unit === item.billing_unit,
    )?.amount ??
    data.products
      .find((p) => p.id === item.product_id)
      ?.units.find((u) => u.billingUnit === item.billing_unit)?.price ??
    null;
  const priceChanged =
    currentPrice !== null && item.price_snapshot !== currentPrice;
  let warning: ReturnType<typeof discrepancy> = null;
  try {
    if (!readOnly && actual.trim())
      warning = discrepancy(
        item.ordered_quantity,
        item.ordered_unit,
        actual,
        unit,
        data.shop,
      );
  } catch {
    /* Server validates invalid input. */
  }
  async function save(next: boolean, confirmed = false) {
    setLocalError("");
    setFailedSave(false);
    if (!actual.trim()) {
      setLocalError("请填写实供数量，空白不代表零或缺货");
      input.current?.focus();
      return;
    }
    if (
      warning?.warning &&
      !confirmed &&
      (dirty || item.discrepancy_ack !== warning.key)
    ) {
      setWarningNext(next);
      return;
    }
    if (
      await mutate(
        {
          action: "saveActual",
          id: item.id,
          version: baseVersion,
          quantity: actual,
          unit,
          acknowledgeDiscrepancy: !!warning?.warning,
          ...(warning?.warning ? { expectedDiscrepancyKey: warning.key } : {}),
        },
        "实供数量已保存，配货勾选保持不变",
      )
    ) {
      localStorage.removeItem(localKey);
      setDirty(false);
      setWarningNext(null);
      if (next) onNext();
    } else setFailedSave(true);
  }
  return (
    <article
      className={`weigh-card ${item.unavailable ? "unavailable" : ""}`}
      id={`actual-${item.id}`}
    >
      <div className="card-heading">
        <h3>{product}</h3>
        <span
          className={`tag ${item.unavailable ? "amber" : item.picking_state === "picked" ? "green" : ""}`}
        >
          {item.unavailable
            ? "缺货 · 不供货"
            : item.picking_state === "picked"
              ? "已配货"
              : "待配货"}
        </span>
      </div>
      <div className="weigh-details">
        <span>
          订购{" "}
          <strong>
            {Number(item.ordered_quantity)} {item.ordered_unit}
          </strong>
        </span>
        <span>
          单价{" "}
          <strong>
            {money(item.price_snapshot)}
            {item.price_snapshot !== null ? ` / ${item.billing_unit}` : ""}
          </strong>
        </span>
      </div>
      {item.last_changed_by && (
        <p className="fine-print">最近修改：{item.last_changed_by}</p>
      )}
      {dirty && baseVersion !== item.version && (
        <div className="inline-note" role="alert">
          <p>此项已被其他人更新，你的输入尚未保存。</p>
          <p>
            最新实供：
            {item.unavailable
              ? "缺货"
              : item.actual_quantity
                ? `${Number(item.actual_quantity)} ${item.actual_unit}`
                : "待确认"}
            ；你的输入：{actual} {unit}
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setBaseVersion(item.version);
              setFailedSave(false);
              setWarningNext(null);
            }}
          >
            已核对，保留输入重新保存
          </button>
        </div>
      )}
      {warning?.warning && !item.unavailable && (
        <p className="inline-note">
          重量{warning.direction} {warning.percent}%（阈值 {warning.threshold}
          %）{!dirty && item.discrepancy_ack === warning.key ? " · 已确认" : ""}
        </p>
      )}
      {!isWeight(item.ordered_unit) &&
        unit === item.ordered_unit &&
        actual.trim() &&
        Number(actual) !== Number(item.ordered_quantity) && (
          <p className="inline-note">
            实供数量有变：订购 {Number(item.ordered_quantity)}{" "}
            {item.ordered_unit}，实供 {actual} {unit}
          </p>
        )}
      {item.unavailable ? (
        <div className="unavailable-body">
          <PackageX size={27} />
          <span>已确认不供货</span>
          <strong>RM 0.00</strong>
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void mutate(
                {
                  action: "setUnavailable",
                  id: item.id,
                  version: item.version,
                  taskVersion: item.task_version,
                  unavailable: false,
                },
                "已取消缺货，请重新确认实供",
              )
            }
          >
            取消缺货
          </button>
        </div>
      ) : (
        <>
          {!isWeight(item.ordered_unit) && isWeight(item.billing_unit) && (
            <p className="inline-note">
              按 {item.ordered_unit} 订购，按实际公斤计费。请称重填写。
            </p>
          )}
          <div className="actual-entry">
            <Field
              label={isWeight(item.billing_unit) ? "实际重量" : "实际供货数量"}
            >
              <input
                ref={input}
                data-actual-input="true"
                aria-label={`${product}实际供货数量`}
                inputMode="decimal"
                placeholder={
                  isWeight(item.billing_unit) ? "填写称重结果" : "填写数量"
                }
                value={actual}
                maxLength={12}
                disabled={busy}
                onChange={(e) => {
                  setActual(e.target.value);
                  setDirty(true);
                  setLocalError("");
                }}
              />
            </Field>
            <Field label="实供单位">
              <select
                aria-label={`${product}实供单位`}
                value={unit}
                disabled={busy}
                onChange={(e) => {
                  setUnit(e.target.value as Unit);
                  setDirty(true);
                }}
              >
                {(isWeight(item.billing_unit)
                  ? ["kg", "g"]
                  : [item.billing_unit]
                ).map((u) => (
                  <option key={u} value={u}>
                    {u === "kg" ? "kg 公斤" : u === "g" ? "g 克" : u}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="amount-row">
            <span>
              {dirty
                ? "预览金额 · 尚未保存"
                : item.actual_confirmed
                  ? "已保存金额"
                  : "待确认金额"}
            </span>
            <strong>
              {preview === null
                ? item.price_snapshot === null
                  ? "价格待填写"
                  : "—"
                : money(preview)}
            </strong>
          </div>
          {item.price_snapshot === null && (
            <p className="inline-error">
              价格待填写。可先保存实供，再到设置填写价格并读取现价。
            </p>
          )}
          {!isWeight(item.billing_unit) && !item.actual_confirmed && !dirty && (
            <p className="inline-note">
              已预填订购数量，请核对后点确认，不会自动计费。
            </p>
          )}
          <ErrorText
            message={localError || (failedSave ? (error ?? "") : "")}
          />
          <div className="weigh-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                setUnavailable({
                  version: item.version,
                  taskVersion: item.task_version,
                })
              }
            >
              标记缺货
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void save(true)}
            >
              <Check size={20} />
              {busy
                ? "保存中…"
                : isWeight(item.billing_unit)
                  ? "保存并下一项"
                  : "确认并下一项"}
              <ChevronRight size={19} />
            </button>
          </div>
          {item.actual_confirmed && (
            <p className={`saved-label ${dirty ? "unsaved" : ""}`}>
              {dirty ? "输入已修改，尚未保存" : "✓ 实供数量已确认"}
            </p>
          )}
        </>
      )}
      {!item.unavailable && (
        <div className="price-footer">
          <span>
            {priceChanged
              ? "设置中的现价已变化，本单仍保留原价。"
              : "本单使用确认订单时的价格。"}
          </span>
          <button
            className="text-button"
            disabled={
              busy ||
              dirty ||
              currentPrice === null ||
              !priceChanged ||
              !allowed(data.user, "manage")
            }
            onClick={() => setRefreshPrice(true)}
          >
            <RefreshCw size={16} />
            读取现价
          </button>
        </div>
      )}
      {unavailable && (
        <Modal
          title="确认不供货？"
          onClose={() => {
            if (!busy) setUnavailable(null);
          }}
        >
          <h3>{product}</h3>
          <p>
            此项将标记缺货，清除实供数量，金额设为 RM
            0.00。配货任务也会标记为缺货。
          </p>
          <ErrorText message={error ?? ""} />
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setUnavailable(null)}
            >
              返回
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                if (
                  await mutate(
                    {
                      action: "setUnavailable",
                      id: item.id,
                      version: unavailable.version,
                      taskVersion: unavailable.taskVersion,
                      unavailable: true,
                    },
                    "已确认缺货，金额为 RM 0.00",
                  )
                ) {
                  localStorage.removeItem(localKey);
                  setUnavailable(null);
                }
              }}
            >
              确认缺货
            </button>
          </div>
        </Modal>
      )}
      {warningNext !== null && warning?.warning && (
        <Modal
          title="核对重量差异"
          onClose={() => {
            if (!busy) setWarningNext(null);
          }}
        >
          <h3>{product}</h3>
          <p>
            订购 {Number(item.ordered_quantity)} {item.ordered_unit}
          </p>
          <p>
            实供 {actual} {unit}
          </p>
          <p className="inline-note">
            {warning.direction} {warning.percent}%，超过 {warning.threshold}%
          </p>
          <ErrorText message={error} />
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setWarningNext(null);
                input.current?.focus();
              }}
            >
              修改重量
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void save(warningNext, true)}
            >
              确认此重量
            </button>
          </div>
        </Modal>
      )}
      {refreshPrice && (
        <Modal
          title="更新这项订单价格？"
          onClose={() => {
            if (!busy) setRefreshPrice(false);
          }}
        >
          <h3>{product}</h3>
          <div className="price-change">
            <span>
              本单原价<strong>{money(item.price_snapshot)}</strong>
            </span>
            <ChevronRight />
            <span>
              当前价格<strong>{money(currentPrice)}</strong>
            </span>
          </div>
          <p>
            计价单位：{item.billing_unit}
            。更新后会按已确认的实供数量重新计算金额。
          </p>
          <ErrorText message={error ?? ""} />
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setRefreshPrice(false)}
            >
              保留原价
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                if (
                  await mutate(
                    {
                      action: "refreshPrice",
                      id: item.id,
                      version: item.version,
                      expectedPrice: currentPrice,
                    },
                    "已明确更新本单价格",
                  )
                )
                  setRefreshPrice(false);
              }}
            >
              确认使用现价
            </button>
          </div>
        </Modal>
      )}
    </article>
  );
}

export default function Weighing({ data, mutate, busy, error }: ViewProps) {
  const [dirtyItems, setDirtyItems] = useState<string[]>([]);
  const changeDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyItems((ids) =>
      dirty
        ? ids.includes(id)
          ? ids
          : [...ids, id]
        : ids.includes(id)
          ? ids.filter((value) => value !== id)
          : ids,
    );
  }, []);
  const [selected, setSelected] = useState<string | null>(null);
  const order = data.orders.find((o) => o.id === selected);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [selected]);
  const all = data.orders.flatMap((o) => o.items);
  function nextItem(index: number) {
    if (!order) return;
    const next = order.items.slice(index + 1).find((i) => !i.unavailable);
    if (next) {
      const card = document.getElementById(`actual-${next.id}`);
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(
        () =>
          card
            ?.querySelector<HTMLInputElement>("[data-actual-input]")
            ?.focus({ preventScroll: true }),
        200,
      );
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>称重与计费</h1>
          <p>按餐馆填写实际重量，或确认供货数量</p>
        </div>
        <div className="page-marker">
          <Scale size={22} />
          {data.date}
        </div>
      </div>
      {!order ? (
        <>
          {data.orders.length === 0 ? (
            <Empty title="这一天还没有餐馆订单">
              先在「今日订单」中添加并确认订单。
            </Empty>
          ) : (
            <>
              <div className="panel weighing-summary">
                <Progress
                  done={
                    all.filter((i) => i.actual_confirmed || i.unavailable)
                      .length
                  }
                  total={all.length}
                  label="实供确认进度"
                />
              </div>
              <div className="orders-grid">
                {data.orders.map((o) => (
                  <button
                    className="restaurant-select-card"
                    key={o.id}
                    onClick={() => setSelected(o.id)}
                  >
                    <div className="card-heading">
                      <h2>{o.restaurant_name}</h2>
                      <ChevronRight />
                    </div>
                    <p>
                      {o.items.length} 项商品 · 配货{" "}
                      {o.items.filter(pickedResolved).length}/{o.items.length}
                    </p>
                    <Progress
                      done={
                        o.items.filter(
                          (i) => i.actual_confirmed || i.unavailable,
                        ).length
                      }
                      total={o.items.length}
                      label="实供已确认"
                    />
                    <div className="restaurant-amount">
                      <span>
                        {o.items.every(billedResolved)
                          ? "商品小计"
                          : "已确认金额"}
                      </span>
                      <strong>{money(subtotal(o.items))}</strong>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <button
            className="text-button back-button"
            onClick={() => setSelected(null)}
          >
            <ArrowLeft size={21} />
            返回餐馆列表
          </button>
          <div className="restaurant-banner">
            <div>
              <h2>{order.restaurant_name}</h2>
              <span>
                {data.date} · {order.items.length} 项商品
              </span>
            </div>
            <Progress
              done={
                order.items.filter((i) => i.actual_confirmed || i.unavailable)
                  .length
              }
              total={order.items.length}
              label="实供已确认"
            />
          </div>
          <div className="weigh-list">
            {order.items.map((item, index) => (
              <fieldset
                className="actual-lock"
                disabled={!!order.finalized_document_id}
                key={`${item.id}:${order.finalized_document_id}`}
              >
                <ActualItem
                  item={item}
                  product={item.product_name}
                  data={data}
                  mutate={mutate}
                  busy={busy}
                  onNext={() => nextItem(index)}
                  error={error}
                  readOnly={!!order.finalized_document_id}
                  onDirtyChange={changeDirty}
                />
              </fieldset>
            ))}
          </div>
          <Documents
            order={order}
            data={data}
            mutate={mutate}
            busy={busy}
            error={error}
            unsaved={order.items.some((i) => dirtyItems.includes(i.id))}
          />
        </>
      )}
    </>
  );
}

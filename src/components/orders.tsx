"use client";
import { allowed } from "@/lib/permissions";
import History from "./history";
import { useEffect, useState } from "react";
import {
  Plus,
  ClipboardList,
  Check,
  ArrowRight,
  Flame,
  Trash2,
  LockKeyhole,
} from "lucide-react";
import {
  billedResolved,
  isWeight,
  money,
  pickedResolved,
  subtotal,
  type Order,
  type Unit,
} from "@/lib/domain";
import type { ViewProps } from "./types";
import { clientId } from "@/lib/client-id";
import { Empty, ErrorText, Field, Modal, Progress } from "./ui";
import ImportFlow, { DraftImports } from "./import-flow";
type DraftLine = {
  key: string;
  productId: string;
  quantity: string;
  unit: Unit;
};
type EditorProps = ViewProps & { order?: Order; onClose: () => void };

function OrderEditor({
  data,
  mutate,
  busy,
  error,
  order,
  onClose,
}: EditorProps) {
  const [restaurantId, setRestaurantId] = useState(order?.restaurant_id ?? "");
  const [urgent, setUrgent] = useState(order?.urgent ?? false);
  const [lines, setLines] = useState<DraftLine[]>(
    order?.items.map((item) => ({
      key: item.id,
      productId: item.product_id,
      quantity: String(Number(item.ordered_quantity)),
      unit: item.ordered_unit,
    })) ?? [],
  );
  const [restored, setRestored] = useState(false);
  const [ready, setReady] = useState(false);
  const [localError, setLocalError] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const key = `fresh-helper-draft:${data.generation}:${data.user?.id ?? "owner"}:${data.date}:${order?.id ?? "new"}`;
  useEffect(() => {
    try {
      const legacyKey = `fresh-helper-draft:${data.date}:${order?.id ?? "new"}`;
      const saved =
        localStorage.getItem(key) ??
        (allowed(data.user, "manage") ? localStorage.getItem(legacyKey) : null);
      if (saved && !localStorage.getItem(key)) {
        localStorage.setItem(key, saved);
        localStorage.removeItem(legacyKey);
      }
      if (saved) {
        const draft = JSON.parse(saved);
        if (
          draft.baseVersion === (order?.version ?? 0) &&
          typeof draft.restaurantId === "string" &&
          typeof draft.urgent === "boolean" &&
          Array.isArray(draft.lines) &&
          draft.lines.length <= 200 &&
          draft.lines.every(
            (l: DraftLine) =>
              typeof l.productId === "string" &&
              typeof l.quantity === "string" &&
              typeof l.unit === "string" &&
              typeof l.key === "string",
          )
        ) {
          setRestaurantId(draft.restaurantId);
          setUrgent(draft.urgent);
          setLines(draft.lines);
          setRestored(true);
        }
      }
    } catch {
      /* An unusable local draft cannot create operational records. */
    }
    setReady(true);
  }, [key, order?.version]);
  useEffect(() => {
    if (ready && !saving) {
      try {
        localStorage.setItem(
          key,
          JSON.stringify({
            baseVersion: order?.version ?? 0,
            restaurantId,
            urgent,
            lines,
          }),
        );
      } catch {
        setLocalError("本机草稿保存失败，请保持此窗口打开并确认订单。");
      }
    }
  }, [key, lines, restaurantId, urgent, ready, saving, order?.version]);
  const active = data.products.filter((p) => p.active);
  const filtered = active.filter((p) =>
    [p.name, ...p.aliases].some((name) =>
      name.toLowerCase().includes(search.toLowerCase()),
    ),
  );
  function addProduct(productId: string) {
    const product = active.find((p) => p.id === productId);
    if (!product) return;
    setLines([
      ...lines,
      {
        key: clientId(),
        productId,
        quantity: "",
        unit: product.units[0].orderUnit,
      },
    ]);
    setSearch("");
    setLocalError("");
  }
  function update(index: number, patch: Partial<DraftLine>) {
    setLines(
      lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
    setLocalError("");
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    if (!restaurantId) {
      setLocalError("请先选择餐馆");
      return;
    }
    if (!lines.length) {
      setLocalError("请至少添加一项商品");
      return;
    }
    if (lines.some((line) => !line.quantity.trim())) {
      setLocalError("请填写每项商品的订购数量");
      return;
    }
    setSaving(true);
    const ok = await mutate(
      {
        action: "saveOrder",
        ...(order ? { id: order.id, version: order.version } : {}),
        restaurantId,
        date: data.date,
        urgent,
        items: lines.map(({ productId, quantity, unit }) => ({
          productId,
          quantity,
          unit,
        })),
      },
      "订单已确认，配货任务已生成",
    );
    if (ok) {
      localStorage.removeItem(key);
      onClose();
    } else setSaving(false);
  }
  const duplicate =
    !order && data.orders.find((o) => o.restaurant_id === restaurantId);
  return (
    <Modal
      title={order ? "修改并重新确认订单" : "手动新增订单"}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form onSubmit={submit}>
        <div className="context-strip">
          <ClipboardList size={20} />
          <strong>{data.date}</strong>
          <span>送货订单</span>
        </div>
        <Field label="餐馆">
          <select
            required
            value={restaurantId}
            disabled={!!order || busy}
            onChange={(e) => setRestaurantId(e.target.value)}
          >
            <option value="">请选择餐馆</option>
            {data.restaurants
              .filter((r) => r.active || r.id === restaurantId)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {!r.active ? "（已停用）" : ""}
                </option>
              ))}
          </select>
        </Field>
        {duplicate && (
          <ErrorText message="这家餐馆当天已有订单，请关闭窗口并修改现有订单。" />
        )}
        <label className="check-line">
          <input
            type="checkbox"
            checked={urgent}
            onChange={(e) => setUrgent(e.target.checked)}
          />
          <Flame size={20} />
          这家餐馆需要优先配货
        </label>
        <div className="section-heading">
          <h3>订购商品</h3>
          <span>{lines.length} 项</span>
        </div>
        {lines.map((line, index) => {
          const product = data.products.find((p) => p.id === line.productId);
          const rule = product?.units.find((u) => u.orderUnit === line.unit);
          return (
            <div className="entry-card" key={line.key}>
              <div className="card-heading">
                <strong>
                  <span className="row-number">{index + 1}</span>
                  {product?.name ?? "商品已不可用"}
                </strong>
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={`移除${product?.name ?? "商品"}`}
                  onClick={() => setLines(lines.filter((_, i) => i !== index))}
                  disabled={busy}
                >
                  <Trash2 size={21} />
                </button>
              </div>
              <div className="quantity-row">
                <Field label="订购数量">
                  <input
                    aria-label={`${product?.name}订购数量`}
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) =>
                      update(index, { quantity: e.target.value })
                    }
                    required
                    placeholder="填写数量"
                    maxLength={12}
                  />
                </Field>
                <Field label="订购单位">
                  <select
                    value={line.unit}
                    onChange={(e) =>
                      update(index, { unit: e.target.value as Unit })
                    }
                  >
                    {product?.units.map((u) => (
                      <option key={u.orderUnit} value={u.orderUnit}>
                        {u.orderUnit}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <p className="item-meta">
                {data.zones.find((z) => z.id === product?.zone_id)?.name} ·{" "}
                {rule?.price === null || !rule
                  ? "价格待填写"
                  : `${money(rule.price)} / ${rule.billingUnit}`}
                {rule &&
                  line.unit !== rule.billingUnit &&
                  !isWeight(line.unit) && (
                    <span className="tag amber">
                      按{line.unit}订购，称重计费
                    </span>
                  )}
              </p>
            </div>
          );
        })}
        <div className="product-picker">
          <Field label="添加商品">
            <input
              type="search"
              placeholder="搜索商品名或别名"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <div className="product-options">
            {filtered.map((product) => (
              <button
                className="product-option"
                key={product.id}
                type="button"
                onClick={() => addProduct(product.id)}
                disabled={busy || lines.length >= 200}
              >
                <span>
                  {product.name}
                  <small>
                    {data.zones.find((z) => z.id === product.zone_id)?.name}
                  </small>
                </span>
                <Plus size={22} />
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="muted">没有匹配商品，请先在设置中添加。</p>
            )}
          </div>
        </div>
        <p className="draft-note">
          {restored ? "已恢复本机未提交草稿。" : "草稿仅保存在这台设备。"}
          确认后才会生成配货任务。
        </p>
        <ErrorText message={localError || error || ""} />
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            稍后再填
          </button>
          <button className="primary" disabled={busy || !!duplicate || !ready}>
            <Check size={21} />
            {busy ? "正在保存…" : "确认订单"}
          </button>
        </div>
        <p className="fine-print">
          确认时读取现价。开始配货后不能更改订购项目。
        </p>
        {order?.items.some((item) => item.actual_confirmed) && (
          <p className="inline-note">
            重新确认会清除这张订单已填写的实供数量，并重新读取现价。请核对后再确认。
          </p>
        )}
      </form>
    </Modal>
  );
}

export default function Orders(
  props: ViewProps & {
    onSettings: () => void;
    onReload: () => Promise<void>;
    onDateChange: (date: string) => void;
  },
) {
  const { data, mutate, busy, onSettings } = props;
  const canImport = allowed(data.user, "import");
  const [editor, setEditor] = useState<Order | "new" | null>(null);
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState<{ id: string | null } | null>(
    null,
  );
  const [draftRefresh, setDraftRefresh] = useState(0);
  const [history, setHistory] = useState(false);
  const items = data.orders.flatMap((o) => o.items);
  const canCreate =
    data.restaurants.some((r) => r.active) &&
    data.products.some((p) => p.active);
  const filtered = data.orders.filter((o) =>
    o.restaurant_name.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>今日订单</h1>
          <p>
            {data.date} <span className="dot-separator">·</span>{" "}
            一家餐馆，一份清楚的订单
          </p>
        </div>
        <div className="order-entry-actions">
          <button className="secondary" onClick={() => setHistory(true)}>
            历史订单
          </button>
          <button
            className="primary"
            disabled={
              busy || !canImport || !data.restaurants.some((r) => r.active)
            }
            onClick={() => setImporting({ id: null })}
          >
            <Plus size={22} />
            导入订单
          </button>
          <button
            className="secondary"
            onClick={() => setEditor("new")}
            disabled={!canCreate || busy || !canImport}
          >
            <Plus size={23} />
            手动新增
          </button>
        </div>
      </div>
      <div className="stats-grid">
        <div className="stat">
          <span>餐馆订单</span>
          <strong>
            {data.orders.length}
            <small> 家</small>
          </strong>
          <ClipboardList />
        </div>
        <div className="stat">
          <span>配货已处理</span>
          <strong>
            {items.filter(pickedResolved).length}
            <small> / {items.length} 项</small>
          </strong>
          <Check />
        </div>
        <div className="stat">
          <span>实供已确认</span>
          <strong>
            {items.filter((i) => i.actual_confirmed || i.unavailable).length}
            <small> / {items.length} 项</small>
          </strong>
          <ScaleIcon />
        </div>
      </div>
      {canImport && (
        <DraftImports
          date={data.date}
          refresh={draftRefresh}
          onOpen={(id) => setImporting({ id })}
        />
      )}
      {!canCreate && (
        <section className="setup-card">
          <div className="setup-number">1</div>
          <div>
            <h2>先把店铺资料准备好</h2>
            <p>在设置中添加区域、餐馆和商品，然后就能录入第一张订单。</p>
          </div>
          <button className="secondary" onClick={onSettings}>
            去设置
            <ArrowRight size={20} />
          </button>
        </section>
      )}
      {data.orders.length === 0 ? (
        <Empty
          title="这一天还没有订单"
          action={
            <button
              className="primary"
              disabled={!canImport}
              onClick={() => (canCreate ? setEditor("new") : onSettings())}
            >
              <Plus size={22} />
              {canCreate ? "添加第一张订单" : "先设置店铺资料"}
            </button>
          }
        >
          确认上方送货日期，再为餐馆添加商品和数量。
        </Empty>
      ) : (
        <>
          <div className="list-toolbar">
            <h2>
              餐馆订单{" "}
              <span className="count-bubble">{data.orders.length}</span>
            </h2>
            <input
              type="search"
              aria-label="搜索餐馆订单"
              placeholder="搜索餐馆"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="orders-grid">
            {filtered.map((order) => {
              const picked = order.items.filter(pickedResolved).length;
              const confirmed = order.items.filter(
                (i) => i.actual_confirmed || i.unavailable,
              ).length;
              const billed = order.items.every(billedResolved);
              return (
                <article className="order-card" key={order.id}>
                  <div className="card-heading">
                    <h2>{order.restaurant_name}</h2>
                    <button
                      className={`urgency-button ${order.urgent ? "urgent" : ""}`}
                      aria-label={`${order.urgent ? "取消" : "设为"}加急：${order.restaurant_name}`}
                      disabled={busy || !canImport}
                      onClick={() =>
                        void mutate(
                          {
                            action: "setUrgent",
                            id: order.id,
                            version: order.version,
                            urgent: !order.urgent,
                          },
                          order.urgent ? "已取消加急" : "已标记加急",
                        )
                      }
                    >
                      <Flame size={19} />
                      {order.urgent ? "加急" : "普通"}
                    </button>
                  </div>
                  <p className="muted">
                    {order.items.length} 项商品{" "}
                    <span className="dot-separator">·</span>{" "}
                    {order.picking_started_at ? "配货进行中" : "等待配货"}
                  </p>
                  <div className="order-products">
                    {order.items.slice(0, 3).map((item) => (
                      <span key={item.id}>
                        {item.product_name}
                        <b>
                          {Number(item.ordered_quantity)} {item.ordered_unit}
                        </b>
                      </span>
                    ))}
                    {order.items.length > 3 && (
                      <small>另有 {order.items.length - 3} 项商品</small>
                    )}
                  </div>
                  <Progress
                    done={picked}
                    total={order.items.length}
                    label="配货"
                  />
                  <div className="order-card-bottom">
                    <span className="muted">
                      实供 {confirmed}/{order.items.length} 项
                    </span>
                    <strong>
                      {billed ? money(subtotal(order.items)) : "计费待完成"}
                    </strong>
                  </div>
                  <button
                    className="secondary full"
                    disabled={busy || !!order.picking_started_at || !canImport}
                    onClick={() => setEditor(order)}
                  >
                    {order.picking_started_at ? (
                      <>
                        <LockKeyhole size={18} />
                        订购项目已锁定
                      </>
                    ) : (
                      <>
                        查看 / 修改订单
                        <ArrowRight size={18} />
                      </>
                    )}
                  </button>
                </article>
              );
            })}
          </div>
          {filtered.length === 0 && (
            <p className="muted">没有匹配的餐馆订单。</p>
          )}
        </>
      )}
      {history && (
        <History
          {...props}
          onClose={() => setHistory(false)}
          onDateChange={props.onDateChange}
        />
      )}
      {importing && (
        <ImportFlow
          {...props}
          draftId={importing.id}
          onClose={() => {
            setImporting(null);
            setDraftRefresh((v) => v + 1);
          }}
          onComplete={async () => {
            await props.onReload();
            setImporting(null);
            setDraftRefresh((v) => v + 1);
          }}
        />
      )}
      {editor && (
        <OrderEditor
          {...props}
          order={editor === "new" ? undefined : editor}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );
}
function ScaleIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="M12 3v17M5 20h14M4 6h16M6 6l-4 8h8L6 6Zm12 0-4 8h8l-4-8Z" />
    </svg>
  );
}

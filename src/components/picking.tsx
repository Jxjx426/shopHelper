"use client";
import { useMemo, useState } from "react";
import {
  Layers,
  Store,
  Flame,
  Check,
  RefreshCw,
  PackageX,
  ChevronDown,
} from "lucide-react";
import {
  pickedResolved,
  totalDemand,
  type Order,
  type OrderItem,
} from "@/lib/domain";
import { Empty, Modal, Progress, ErrorText } from "./ui";
import type { ViewProps } from "./types";
type Task = { item: OrderItem; order: Order };
export default function Picking({ data, mutate, busy, error }: ViewProps) {
  const [view, setView] = useState<"zone" | "restaurant">("zone");
  const [expanded, setExpanded] = useState<string[]>([]);
  const isOpen = (id: string) => expanded.includes(`${data.date}:${id}`);
  function toggle(id: string) {
    const key = `${data.date}:${id}`;
    setExpanded((current) =>
      current.includes(key)
        ? current.filter((v) => v !== key)
        : [...current, key],
    );
  }
  const [incomplete, setIncomplete] = useState(false);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState<Task | null>(null);
  const tasks = useMemo(
    () =>
      data.orders.flatMap((order) =>
        order.items.map((item) => ({ item, order })),
      ),
    [data.orders],
  );
  function refreshFilter() {
    setVisibleIds(
      tasks.filter((t) => !pickedResolved(t.item)).map((t) => t.item.id),
    );
  }
  const visible = tasks.filter(
    (t) => !incomplete || visibleIds.includes(t.item.id),
  );
  function taskRow(task: Task) {
    const { item, order } = task;
    return (
      <div
        key={item.id}
        title={
          item.last_changed_by ? `最后修改：${item.last_changed_by}` : undefined
        }
        className={`pick-row ${item.picking_state === "picked" ? "done" : ""} ${item.unavailable ? "unavailable" : ""}`}
      >
        <label className="pick-label">
          <input
            type="checkbox"
            checked={item.picking_state === "picked"}
            disabled={busy || item.unavailable || !!order.finalized_document_id}
            aria-label={`${order.restaurant_name} ${item.product_name} ${Number(item.ordered_quantity)} ${item.ordered_unit} 配货`}
            onChange={(e) =>
              void mutate(
                {
                  action: "setPicking",
                  id: item.id,
                  version: item.task_version,
                  picked: e.target.checked,
                },
                e.target.checked
                  ? "已配货，实供数量仍需单独确认"
                  : "已撤销配货勾选",
              )
            }
          />
          <span>
            <strong>
              {view === "zone" ? order.restaurant_name : item.product_name}
            </strong>
            {(item.unavailable || order.urgent) && (
              <span className="pick-subtext">
                {item.unavailable && "缺货"}
                {order.urgent && (
                  <span className="urgent-inline">
                    <Flame size={15} />
                    加急
                  </span>
                )}
              </span>
            )}
          </span>
        </label>
        <div className="pick-quantity">
          <strong>
            {Number(item.ordered_quantity)} <small>{item.ordered_unit}</small>
          </strong>
          <button
            className="text-button"
            aria-label={`${item.unavailable ? "取消缺货" : "标记缺货"}：${order.restaurant_name} ${item.product_name}`}
            disabled={busy || !!order.finalized_document_id}
            onClick={() =>
              item.unavailable
                ? void mutate(
                    {
                      action: "setUnavailable",
                      id: item.id,
                      version: item.version,
                      taskVersion: item.task_version,
                      unavailable: false,
                    },
                    "已取消缺货，请重新配货和确认实供",
                  )
                : setUnavailable(task)
            }
          >
            {item.unavailable ? "取消缺货" : "缺货"}
          </button>
        </div>
      </div>
    );
  }
  const orderedZones = [...data.zones].sort(
    (a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>配货清单</h1>
        </div>
        <div className="page-marker">
          <Layers size={22} />
          {data.date}
        </div>
      </div>
      <div className="panel picking-summary">
        <Progress
          done={tasks.filter((t) => pickedResolved(t.item)).length}
          total={tasks.length}
          label="当天配货进度"
        />
        <span className="muted">
          {tasks.filter((t) => t.item.unavailable).length} 项缺货
        </span>
      </div>
      <div className="picking-toolbar">
        <div className="segmented" aria-label="配货显示方式">
          <button
            className={view === "zone" ? "selected" : ""}
            onClick={() => setView("zone")}
          >
            <Layers size={19} />
            按区域
          </button>
          <button
            className={view === "restaurant" ? "selected" : ""}
            onClick={() => setView("restaurant")}
          >
            <Store size={19} />
            按餐馆
          </button>
        </div>
        <div className="filter-group">
          <label className="check-line">
            <input
              type="checkbox"
              checked={incomplete}
              onChange={(e) => {
                setIncomplete(e.target.checked);
                refreshFilter();
              }}
            />
            只看未完成
          </label>
          {incomplete && (
            <button className="text-button" onClick={refreshFilter}>
              <RefreshCw size={18} />
              更新列表
            </button>
          )}
        </div>
      </div>
      {tasks.length === 0 ? (
        <Empty title="还没有需要配货的商品">
          请先在「今日订单」中确认一张订单。
        </Empty>
      ) : visible.length === 0 ? (
        <Empty title={incomplete ? "当前没有未完成项目" : "没有配货项目"}>
          {incomplete
            ? "如有新订单，点击「更新列表」查看。"
            : "请先确认当天订单。"}
        </Empty>
      ) : view === "zone" ? (
        <div className="zone-list">
          {orderedZones.map((zone) => {
            const zoneAll = tasks.filter((t) => t.item.zone_id === zone.id);
            const zoneVisible = visible.filter(
              (t) => t.item.zone_id === zone.id,
            );
            if (!zoneVisible.length) return null;
            const products = [
              ...new Set(zoneVisible.map((t) => t.item.product_id)),
            ].sort((a, b) => {
              const pa = data.products.find((p) => p.id === a),
                pb = data.products.find((p) => p.id === b);
              return (
                (pa?.sort_order ?? 0) - (pb?.sort_order ?? 0) ||
                (pa?.name ?? a).localeCompare(pb?.name ?? b)
              );
            });
            return (
              <section key={zone.id} className="zone-section">
                <button
                  type="button"
                  className="zone-heading picking-group-toggle"
                  aria-expanded={isOpen(`zone-${zone.id}`)}
                  aria-controls={`zone-items-${zone.id}`}
                  onClick={() => toggle(`zone-${zone.id}`)}
                >
                  <div className="zone-name">
                    <span className="zone-icon">
                      <Layers size={21} />
                    </span>
                    <span className="group-name">{zone.name}</span>
                  </div>
                  <span className="tag">
                    {zoneAll.filter((t) => pickedResolved(t.item)).length} /{" "}
                    {zoneAll.length}
                  </span>
                  <ChevronDown size={20} className="group-chevron" />
                </button>
                {isOpen(`zone-${zone.id}`) && (
                  <div id={`zone-items-${zone.id}`}>
                    {products.map((productId) => {
                      const all = zoneAll.filter(
                          (t) => t.item.product_id === productId,
                        ),
                        subset = zoneVisible.filter(
                          (t) => t.item.product_id === productId,
                        );
                      return (
                        <article key={productId} className="pick-product">
                          <div className="product-group-header">
                            <h3>{all[0].item.product_name}</h3>
                            <span>
                              订购合计{" "}
                              <strong>
                                {totalDemand(all.map((t) => t.item))}
                              </strong>
                            </span>
                          </div>
                          {subset.map(taskRow)}
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="restaurant-picking">
          {[...data.orders]
            .sort(
              (a, b) =>
                Number(b.urgent) - Number(a.urgent) ||
                a.created_at.localeCompare(b.created_at),
            )
            .map((order) => {
              const selected = visible.filter((t) => t.order.id === order.id);
              if (!selected.length) return null;
              return (
                <section className="zone-section" key={order.id}>
                  <button
                    type="button"
                    className="zone-heading picking-group-toggle"
                    aria-expanded={isOpen(`restaurant-${order.id}`)}
                    aria-controls={`restaurant-items-${order.id}`}
                    onClick={() => toggle(`restaurant-${order.id}`)}
                  >
                    <div className="zone-name">
                      <Store size={24} />
                      <span className="group-name">
                        {order.restaurant_name}
                      </span>
                      {order.urgent && (
                        <span className="tag amber">
                          <Flame size={16} />
                          加急
                        </span>
                      )}
                    </div>
                    <span className="tag">
                      {order.items.filter(pickedResolved).length} /{" "}
                      {order.items.length}
                    </span>
                    <ChevronDown size={20} className="group-chevron" />
                  </button>
                  {isOpen(`restaurant-${order.id}`) && (
                    <div
                      className="pick-product restaurant-checklist"
                      id={`restaurant-items-${order.id}`}
                    >
                      {[...selected]
                        .sort((a, b) => {
                          const zoneIndex = (id: string) => {
                            const i = orderedZones.findIndex(
                              (z) => z.id === id,
                            );
                            return i < 0 ? orderedZones.length : i;
                          };
                          return (
                            zoneIndex(a.item.zone_id) -
                              zoneIndex(b.item.zone_id) ||
                            (data.products.find(
                              (p) => p.id === a.item.product_id,
                            )?.sort_order ?? 0) -
                              (data.products.find(
                                (p) => p.id === b.item.product_id,
                              )?.sort_order ?? 0) ||
                            a.item.position - b.item.position
                          );
                        })
                        .map(taskRow)}
                    </div>
                  )}
                </section>
              );
            })}
        </div>
      )}
      <details className="stage-note picking-help">
        <summary>配货说明</summary>
        首次勾选或标记缺货后，该餐馆的订购项目会锁定。撤销勾选不会解除锁定。
        {incomplete && (
          <>
            <br />
            完成的项目暂时保留原位，点击「更新列表」后才隐藏。
          </>
        )}
      </details>
      {unavailable && (
        <Modal
          title="确认这项商品缺货？"
          onClose={() => {
            if (!busy) setUnavailable(null);
          }}
        >
          <div className="confirm-illustration">
            <PackageX size={42} />
          </div>
          <h3>
            {unavailable.order.restaurant_name} ·{" "}
            {unavailable.item.product_name}
          </h3>
          <p>
            订购 {Number(unavailable.item.ordered_quantity)}{" "}
            {unavailable.item.ordered_unit}
          </p>
          <p>
            此项将标记为不供货，金额为 RM 0.00，并清除这项已填写的实供数量。
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
                      id: unavailable.item.id,
                      version: unavailable.item.version,
                      taskVersion: unavailable.item.task_version,
                      unavailable: true,
                    },
                    "已确认缺货，金额为 RM 0.00",
                  )
                )
                  setUnavailable(null);
              }}
            >
              <Check size={20} />
              确认缺货
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

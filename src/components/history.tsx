"use client";
import { startFileRequest } from "@/lib/cloud-request.client";
import { waitCloudJob } from "@/lib/cloud-jobs.client";
import { downloadTicket } from "@/lib/file-transfer.client";
import { allowed } from "@/lib/permissions";
import { useEffect, useState } from "react";
import { money, type Order } from "@/lib/domain";
import type { ViewProps } from "./types";
import { ErrorText, Field, Modal } from "./ui";
import { DocumentLinks, type DocumentInfo } from "./documents";
import type { PdfSummary, PdfLanguage } from "@/lib/pdf-options";
type Entry = Omit<Order, "items"> & { item_count: number };
type CopyReview = {
  sourceVersion: number;
  restaurantName: string;
  target: Order | null;
  token: string;
  date: string;
  items: {
    productId: string;
    name: string;
    quantity: string;
    unit: string;
    billingUnit: string | null;
    price: string | null;
    active: boolean;
  }[];
};
async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
export default function History({
  data,
  mutate,
  busy,
  error,
  onClose,
  onDateChange,
}: ViewProps & { onClose: () => void; onDateChange: (date: string) => void }) {
  const [filter, setFilter] = useState({
    query: "",
    from: "",
    to: "",
    deleted: false,
  });
  const [applied, setApplied] = useState(filter);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<{
    orders: Entry[];
    total: number;
    pages: number;
  } | null>(null);
  const [detail, setDetail] = useState<{
    order: Order;
    documents: DocumentInfo[];
  } | null>(null);
  const [localError, setLocalError] = useState("");
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [summary, setSummary] = useState<PdfSummary>("first");
  const [language, setLanguage] = useState<PdfLanguage>("zh");
  const [deleting, setDeleting] = useState(false);
  const [copy, setCopy] = useState(false);
  const [date, setDate] = useState(data.date);
  const [copyReview, setCopyReview] = useState<CopyReview | null>(null);
  const [replace, setReplace] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setList(null);
    const p = new URLSearchParams({
      ...applied,
      deleted: String(applied.deleted),
      page: String(page),
    });
    void read<{ orders: Entry[]; total: number; pages: number }>(
      `/api/history?${p}`,
    )
      .then((v) => {
        if (!cancelled) {
          setList(v);
          setLocalError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setLocalError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, page, revision]);
  async function open(id: string) {
    setLocalError("");
    try {
      setDetail(await read(`/api/history?id=${encodeURIComponent(id)}`));
    } catch (e) {
      setLocalError((e as Error).message);
    }
  }
  async function exportPdf() {
    setExporting(true);
    setLocalError("");
    setExportMessage("");
    try {
      const params = new URLSearchParams({
        from: filter.from,
        to: filter.to,
        query: filter.query,
        summary,
        language,
      });
      const response = await startFileRequest(
        `/api/documents/export?${params}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(60000),
        },
      );
      if (!response.ok)
        throw new Error((await response.json()).error ?? "导出失败，请重试");
      if (response.status === 202) {
        const ticket = await waitCloudJob(await response.json());
        await downloadTicket(ticket);
        setExportMessage(`已导出 ${ticket.count} 份已定稿单据`);
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `Order-List-${filter.from}-${filter.to}${language === "en" ? "-en" : ""}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setExportMessage(
        `已导出 ${response.headers.get("X-Order-Count") ?? ""} 份已定稿单据`,
      );
    } catch (e) {
      setLocalError(
        (e as Error).name === "TimeoutError"
          ? "合并超时，请缩短日期范围后重试"
          : (e as Error).message,
      );
    } finally {
      setExporting(false);
    }
  }
  return (
    <Modal title="历史订单" wide onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setApplied({ ...filter });
        }}
      >
        <Field label="餐馆名称（留空为全部）">
          <input
            value={filter.query}
            onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            maxLength={80}
          />
        </Field>
        <div className="two-columns">
          <Field label="从日期">
            <input
              type="date"
              value={filter.from}
              onChange={(e) =>
                setFilter({
                  ...filter,
                  from: e.target.value,
                  to:
                    !filter.to || filter.to === filter.from
                      ? e.target.value
                      : filter.to,
                })
              }
            />
          </Field>
          <Field label="到日期">
            <input
              type="date"
              value={filter.to}
              onChange={(e) => setFilter({ ...filter, to: e.target.value })}
            />
          </Field>
        </div>
        <div className="two-columns">
          <Field label="单据语言">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as PdfLanguage)}
              disabled={exporting}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </Field>
          <Field label="PDF 汇总页">
            <select
              value={summary}
              onChange={(e) => setSummary(e.target.value as PdfSummary)}
              disabled={exporting}
            >
              <option value="first">第一页</option>
              <option value="last">最后一页</option>
              <option value="none">不加汇总页</option>
            </select>
          </Field>
        </div>
        <label className="check-line">
          <input
            type="checkbox"
            checked={filter.deleted}
            onChange={(e) =>
              setFilter({ ...filter, deleted: e.target.checked })
            }
          />
          查看已删除订单
        </label>
        <div className="action-wrap">
          <button
            type="button"
            className="secondary"
            onClick={() =>
              setFilter({ ...filter, from: data.date, to: data.date })
            }
          >
            仅选当天
          </button>
          <button className="primary" disabled={loading}>
            查询
          </button>
          <button
            type="button"
            className="secondary"
            disabled={
              exporting || !filter.from || !filter.to || filter.from > filter.to
            }
            onClick={() => void exportPdf()}
          >
            {exporting ? "正在合并…" : "合并 PDF"}
          </button>
        </div>
        <p className="fine-print">
          选同一天或日期范围，仅合并最新已定稿单据；已删除单据不包括在内。
        </p>
        {exportMessage && (
          <p className="saved-label" role="status">
            {exportMessage}
          </p>
        )}
      </form>
      <ErrorText message={localError || error} />
      {loading && <p>正在读取…</p>}
      {list && (
        <>
          <p className="fine-print">
            共 {list.total} 份 · 第 {page} / {list.pages} 页
          </p>
          <div className="history-list">
            {list.orders.map((o) => (
              <button
                key={o.id}
                className="history-row"
                onClick={() => void open(o.id)}
              >
                <strong>{o.restaurant_name}</strong>
                <span>
                  {o.delivery_date} · {o.item_count} 项 ·{" "}
                  {o.deleted_at
                    ? "已删除"
                    : o.finalized_document_id
                      ? "已定稿"
                      : "未定稿"}
                </span>
              </button>
            ))}
          </div>
          <div className="action-wrap">
            <button
              className="secondary"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              上一页
            </button>
            <button
              className="secondary"
              disabled={page >= list.pages || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
        </>
      )}
      {detail && (
        <Modal
          title={`${detail.order.restaurant_name} · ${detail.order.delivery_date}`}
          wide
          onClose={() => {
            if (!busy) setDetail(null);
          }}
        >
          <ErrorText message={localError || error} />
          {detail.order.items.map((i) => (
            <article className="history-item" key={i.id}>
              <h3>{i.product_name}</h3>
              <p>
                订购 {Number(i.ordered_quantity)} {i.ordered_unit} · 实供{" "}
                {i.unavailable
                  ? "缺货"
                  : i.actual_confirmed
                    ? `${Number(i.actual_quantity)} ${i.actual_unit}`
                    : "待确认"}
              </p>
              <p>
                {money(i.price_snapshot)} / {i.billing_unit} ·{" "}
                {i.amount === null ? "待确认" : money(i.amount)}
              </p>
            </article>
          ))}
          {detail.documents.map((d) => (
            <DocumentLinks key={d.id} document={d} />
          ))}
          <div className="action-wrap">
            <button
              className="secondary"
              disabled={busy || !allowed(data.user, "manage")}
              onClick={() => {
                setDate(data.date);
                setCopyReview(null);
                setReplace(false);
                setCopy(true);
              }}
            >
              复制订单
            </button>
            {detail.order.deleted_at ? (
              <button
                className="primary"
                disabled={busy || !allowed(data.user, "manage")}
                onClick={async () => {
                  if (
                    await mutate(
                      {
                        action: "setOrderDeleted",
                        id: detail.order.id,
                        version: detail.order.version,
                        deleted: false,
                      },
                      "订单已恢复",
                    )
                  ) {
                    setDetail(null);
                    setRevision((v) => v + 1);
                  }
                }}
              >
                恢复订单
              </button>
            ) : (
              <button
                className="secondary danger-text"
                disabled={busy || !allowed(data.user, "manage")}
                onClick={() => setDeleting(true)}
              >
                删除订单
              </button>
            )}
          </div>
          {deleting && (
            <Modal
              title="删除这份订单？"
              onClose={() => {
                if (!busy) setDeleting(false);
              }}
            >
              <h3>{detail.order.restaurant_name}</h3>
              <p>送货日期：{detail.order.delivery_date}</p>
              <p>
                将从配货清单和当天金额中移除 {detail.order.items.length}{" "}
                项需求。订单和送货单版本会保留，可在「已删除订单」中恢复。
              </p>
              <ErrorText message={error} />
              <div className="modal-actions">
                <button
                  className="secondary"
                  disabled={busy || !allowed(data.user, "manage")}
                  onClick={() => setDeleting(false)}
                >
                  取消
                </button>
                <button
                  className="primary"
                  disabled={busy || !allowed(data.user, "manage")}
                  onClick={async () => {
                    if (
                      await mutate(
                        {
                          action: "setOrderDeleted",
                          id: detail.order.id,
                          version: detail.order.version,
                          deleted: true,
                        },
                        "订单已删除，可在历史中恢复",
                      )
                    ) {
                      setDeleting(false);
                      setDetail(null);
                      setRevision((v) => v + 1);
                    }
                  }}
                >
                  确认删除订单
                </button>
              </div>
            </Modal>
          )}
          {copy && (
            <Modal
              title="复制到指定日期"
              onClose={() => {
                if (!busy) setCopy(false);
              }}
            >
              <h3>{detail.order.restaurant_name}</h3>
              <Field label="目标送货日期">
                <input
                  type="date"
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setCopyReview(null);
                    setReplace(false);
                  }}
                />
              </Field>
              <button
                className="secondary"
                disabled={busy || !date}
                onClick={async () => {
                  setLocalError("");
                  try {
                    setCopyReview(
                      await read(
                        `/api/history?id=${detail.order.id}&copyTo=${date}`,
                      ),
                    );
                  } catch (e) {
                    setLocalError((e as Error).message);
                  }
                }}
              >
                核对目标日期及现价
              </button>
              {copyReview && (
                <>
                  <p className="inline-note">
                    只复制订购项目，使用当前价格。配货、实供、加急和定稿均重新开始。
                  </p>
                  {copyReview.items.map((i, index) => (
                    <div className="history-item" key={index}>
                      <strong>{i.name}</strong>
                      <p>
                        {Number(i.quantity)} {i.unit} · {money(i.price)} /{" "}
                        {i.billingUnit ?? "单位待设置"}
                        {!i.active ? " · 已停用" : ""}
                      </p>
                    </div>
                  ))}
                  {copyReview.target && (
                    <div className="inline-note">
                      <p>
                        目标日期已有 {copyReview.target.restaurant_name}{" "}
                        的订单。
                      </p>
                      <button
                        className="text-button"
                        onClick={() => {
                          onDateChange(date);
                          onClose();
                        }}
                      >
                        前往目标日期查看
                      </button>
                      {copyReview.target.picking_started_at ? (
                        <p>已开始配货，不能替换。请选择其他日期。</p>
                      ) : (
                        <label className="check-line">
                          <input
                            type="checkbox"
                            checked={replace}
                            onChange={(e) => setReplace(e.target.checked)}
                          />
                          确认替换原单，清除原实供并读取现价
                        </label>
                      )}
                    </div>
                  )}
                  <ErrorText message={localError || error} />
                  <button
                    className="primary full"
                    disabled={
                      busy ||
                      !!copyReview.target?.picking_started_at ||
                      (!!copyReview.target && !replace) ||
                      copyReview.items.some((i) => !i.active || !i.billingUnit)
                    }
                    onClick={async () => {
                      if (
                        await mutate(
                          {
                            action: "copyOrder",
                            id: detail.order.id,
                            version: copyReview.sourceVersion,
                            date: copyReview.date,
                            token: copyReview.token,
                            mode: copyReview.target ? "replace" : "new",
                            ...(copyReview.target
                              ? { targetVersion: copyReview.target.version }
                              : {}),
                          },
                          "订单已复制",
                        )
                      ) {
                        onDateChange(copyReview.date);
                        onClose();
                      }
                    }}
                  >
                    确认复制
                  </button>
                </>
              )}
            </Modal>
          )}
        </Modal>
      )}
    </Modal>
  );
}

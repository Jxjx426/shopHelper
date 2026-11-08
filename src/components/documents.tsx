"use client";
import { useEffect, useState } from "react";
import { Download, Share2, FileCheck, FileText } from "lucide-react";
import { money, type Order, type Workspace } from "@/lib/domain";
import type { DocumentSnapshot } from "@/lib/documents.server";
import type { Mutate } from "./types";
import { ErrorText, Modal } from "./ui";
import { allowed } from "@/lib/permissions";
export type DocumentInfo = {
  id: string;
  number: string;
  revision: number;
  superseded_at: string | null;
};
export function DocumentLinks({ document }: { document: DocumentInfo }) {
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const url = `/api/documents/${document.id}/pdf`;
  async function share() {
    setWorking(true);
    setMessage("");
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("无法读取送货单");
      const file = new File([await response.blob()], `${document.number}.pdf`, {
        type: "application/pdf",
      });
      if (navigator.canShare?.({ files: [file] }))
        await navigator.share({ files: [file], title: "送货单" });
      else {
        const a = window.document.createElement("a");
        a.href = `${url}?download=1`;
        a.download = `${document.number}.pdf`;
        a.click();
        setMessage("已改用下载，请在手机中手动分享。");
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError")
        setMessage("分享未完成，请点「下载 PDF」后手动分享。");
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="document-links">
      <strong>
        {document.number} · 第 {document.revision} 版
        {document.superseded_at ? " · 已被替代" : ""}
      </strong>
      <div className="action-wrap">
        <a
          className="secondary"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <FileText size={18} />
          预览 PDF
        </a>
        <a className="secondary" href={`${url}?download=1`}>
          <Download size={18} />
          下载 PDF
        </a>
        <button
          className="secondary"
          disabled={working}
          onClick={() => void share()}
        >
          <Share2 size={18} />
          分享
        </button>
      </div>
      {message && <p className="fine-print">{message}</p>}
    </div>
  );
}
type Review = {
  snapshot: DocumentSnapshot;
  token: string;
  documents: DocumentInfo[];
  finalizedDocumentId: string | null;
  orderVersion: number;
};
export default function Documents({
  order,
  data,
  mutate,
  busy,
  error,
  unsaved,
}: {
  order: Order;
  data: Workspace;
  mutate: Mutate;
  busy: boolean;
  error?: string;
  unsaved: boolean;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [loadError, setLoadError] = useState("");
  const [checked, setChecked] = useState(false);
  const [reopen, setReopen] = useState(false);
  const [ack, setAck] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (unsaved) setChecked(false);
  }, [unsaved]);
  const revision = JSON.stringify([
    order.version,
    order.items.map((i) => [i.version, i.task_version]),
    data.shop,
  ]);
  useEffect(() => {
    let cancelled = false;
    setChecked(false);
    setReview(null);
    void fetch(`/api/orders/${order.id}/document`, { cache: "no-store" })
      .then(async (r) => {
        const value = await r.json();
        if (!r.ok) throw new Error(value.error);
        if (!cancelled) {
          setReview(value);
          setLoadError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [order.id, revision, reload]);
  if (!review)
    return (
      <section className="panel">
        <h2>送货单</h2>
        <ErrorText message={loadError} />
        {loadError ? (
          <button className="secondary" onClick={() => setReload((v) => v + 1)}>
            重新读取
          </button>
        ) : (
          <p>正在核对…</p>
        )}
      </section>
    );
  const s = review.snapshot;
  return (
    <section className="panel document-panel">
      <h2>送货单</h2>
      <dl className="bill-totals">
        <div>
          <dt>{s.total === null ? "已确认商品小计" : "商品小计"}</dt>
          <dd>{money(s.subtotal)}</dd>
        </div>
        <div>
          <dt>舍入调整</dt>
          <dd>
            {s.rounding.startsWith("-") ? "" : "+"}
            {money(s.rounding)}
          </dd>
        </div>
        <div>
          <dt>最终总额</dt>
          <dd>{s.total === null ? "待完成" : money(s.total)}</dd>
        </div>
      </dl>
      {review.finalizedDocumentId ? (
        <>
          <p className="saved-label">已定稿，金额已锁定。</p>
          {review.documents
            .filter((d) => d.id === review.finalizedDocumentId)
            .map((d) => (
              <DocumentLinks document={d} key={d.id} />
            ))}
          {allowed(data.user, "manage") && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setReopen(true)}
            >
              重新打开修订
            </button>
          )}
        </>
      ) : (
        <>
          {unsaved && (
            <p className="inline-error">
              有实供输入尚未保存，请逐项保存后定稿。PDF 仅使用已保存的数据。
            </p>
          )}
          {s.issues.length > 0 && (
            <div className="inline-note">
              <strong>定稿前还需处理</strong>
              {s.issues.map((issue, index) => (
                <p key={index}>{issue}</p>
              ))}
            </div>
          )}
          <div className="action-wrap">
            <a
              className="secondary"
              href={`/api/orders/${order.id}/document?pdf=draft`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <FileText size={18} />
              预览草稿 PDF
            </a>
          </div>
          <label className="check-line">
            <input
              type="checkbox"
              checked={checked}
              disabled={
                busy ||
                unsaved ||
                s.issues.length > 0 ||
                !allowed(data.user, "finalize")
              }
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span>已核对餐馆、实供、价格及总额</span>
          </label>
          <ErrorText message={error} />
          <button
            className="primary full"
            disabled={
              busy ||
              unsaved ||
              !checked ||
              s.issues.length > 0 ||
              !allowed(data.user, "finalize")
            }
            onClick={async () => {
              if (
                await mutate(
                  {
                    action: "finalizeOrder",
                    id: order.id,
                    token: review.token,
                    finalChecked: true,
                  },
                  "送货单已定稿",
                )
              )
                setReload((v) => v + 1);
            }}
          >
            <FileCheck size={20} />
            {busy ? "处理中…" : "确认定稿"}
          </button>
          {!allowed(data.user, "finalize") && (
            <p className="fine-print">请由店主或获授权的员工定稿。</p>
          )}
        </>
      )}
      {review.documents.some((d) => d.id !== review.finalizedDocumentId) && (
        <details>
          <summary>以前的版本</summary>
          {review.documents
            .filter((d) => d.id !== review.finalizedDocumentId)
            .map((d) => (
              <DocumentLinks key={d.id} document={d} />
            ))}
        </details>
      )}
      {reopen && (
        <Modal
          title="重新打开修订？"
          onClose={() => {
            if (!busy) setReopen(false);
          }}
        >
          <p>
            之前的 PDF 可能已经分享。旧版会保留，新版定稿后旧版标记为已被替代。
          </p>
          <p>只能改实供和价格，不能修改已开始配货的订购清单。</p>
          <label className="check-line">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            我了解并确认修订
          </label>
          <ErrorText message={error} />
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setReopen(false)}
            >
              取消
            </button>
            <button
              className="primary"
              disabled={busy || !ack}
              onClick={async () => {
                if (
                  await mutate(
                    {
                      action: "reopenOrder",
                      id: order.id,
                      version: review.orderVersion,
                      acknowledgeShared: true,
                    },
                    "订单已重新打开",
                  )
                ) {
                  setReopen(false);
                  setAck(false);
                  setReload((v) => v + 1);
                }
              }}
            >
              确认重新打开
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

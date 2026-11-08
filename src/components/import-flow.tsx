"use client";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  FileText,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  ShieldCheck,
  ArrowLeft,
  Eye,
  Save,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { clientId } from "@/lib/client-id";
import { money, type Product, type Unit } from "@/lib/domain";
import { blankLine, lineProblems } from "@/lib/extraction";
import {
  MAX_TEXT_LENGTH,
  PRIVACY_VERSION,
  normalizeName,
  type ConfirmationMode,
  type DraftSummary,
  type ImportConfig,
  type ImportDraft,
  type ImportPreview,
  type ReviewLine,
} from "@/lib/import-types";
import type { ViewProps } from "./types";
import { ErrorText, Field, Modal } from "./ui";
import { ProductEditor } from "./settings";
import ScreenshotEditor, { type ScreenshotPayload } from "./screenshot-editor";

async function api<T>(url: string, input?: unknown, key?: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...(input === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key ?? clientId(),
          },
          body: JSON.stringify(input),
        }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "操作失败，草稿仍保留");
  return body;
}
const draftLabels = {
  draft: "未确认",
  review: "待审核",
  extracting: "识别中",
  failed: "识别未完成",
  confirmed: "已确认",
};
export function DraftImports({
  date,
  onOpen,
  refresh,
}: {
  date: string;
  onOpen: (id: string | null) => void;
  refresh: number;
}) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [deletedDrafts, setDeletedDrafts] = useState<DraftSummary[]>([]);
  const [showDeleted, setShowDeleted] = useState(false);
  const [deleting, setDeleting] = useState<DraftSummary | null>(null);
  const [working, setWorking] = useState(false);
  const [revision, setRevision] = useState(0);
  const [operationError, setOperationError] = useState("");
  const lock = useRef(false);
  const pendingRequest = useRef<{ signature: string; key: string } | null>(
    null,
  );
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void api<{ drafts: DraftSummary[]; deletedDrafts: DraftSummary[] }>(
      `/api/imports?date=${date}`,
    )
      .then((value) => {
        if (!cancelled) {
          setDrafts(value.drafts);
          setDeletedDrafts(value.deletedDrafts);
          setError("");
        }
      })
      .catch(() => {
        if (!cancelled) setError("未能读取导入草稿，可点击导入订单后重试。");
      });
    return () => {
      cancelled = true;
    };
  }, [date, refresh, revision]);
  useEffect(() => {
    setShowDeleted(false);
    setDeleting(null);
    setOperationError("");
  }, [date]);
  async function changeDeleted(draft: DraftSummary, deleted: boolean) {
    if (lock.current) return;
    lock.current = true;
    setWorking(true);
    setOperationError("");
    const signature = `${draft.id}:${draft.version}:${deleted}`;
    if (pendingRequest.current?.signature !== signature)
      pendingRequest.current = { signature, key: clientId() };
    try {
      await api(
        `/api/imports/${draft.id}`,
        { action: "setDeleted", version: draft.version, deleted },
        pendingRequest.current.key,
      );
      pendingRequest.current = null;
      setDeleting(null);
    } catch (error) {
      setOperationError(
        error instanceof Error ? error.message : "操作失败，请重试",
      );
      setDeleting(null);
    } finally {
      setRevision((v) => v + 1);
      setWorking(false);
      lock.current = false;
    }
  }
  if (!drafts.length && !deletedDrafts.length && !error && !operationError)
    return null;
  return (
    <section className="draft-imports">
      <div className="section-heading">
        <h2>{showDeleted ? "已删除草稿" : "待审核草稿"}</h2>
        <span>{showDeleted ? deletedDrafts.length : drafts.length} 份</span>
      </div>
      {(deletedDrafts.length > 0 || showDeleted) && (
        <button
          className="text-button"
          onClick={() => setShowDeleted((v) => !v)}
          disabled={working}
        >
          {showDeleted ? "返回待审核" : `已删除（${deletedDrafts.length}）`}
        </button>
      )}
      <ErrorText message={operationError || error} />
      {(showDeleted ? deletedDrafts : drafts).map((draft) => (
        <div className="draft-import-row" key={draft.id}>
          <button
            className="draft-open"
            disabled={working || showDeleted}
            onClick={() => onOpen(draft.id)}
            aria-label={`继续审核：${draft.restaurant_name}`}
          >
            {draft.source_kind === "image" ? (
              <ImageIcon size={22} />
            ) : (
              <FileText size={22} />
            )}
            <span className="draft-info">
              <strong>{draft.restaurant_name}</strong>
              {!showDeleted && <small>{draftLabels[draft.status]}</small>}
            </span>
            {!showDeleted && <span className="draft-continue">审核 →</span>}
          </button>
          <button
            className={`text-button ${showDeleted ? "" : "draft-delete"}`}
            disabled={working || draft.status === "extracting"}
            aria-label={`${showDeleted ? "恢复" : "删除"}草稿：${draft.restaurant_name}`}
            onClick={() =>
              showDeleted
                ? void changeDeleted(draft, false)
                : setDeleting(draft)
            }
          >
            {showDeleted ? <RotateCcw size={19} /> : <Trash2 size={19} />}
            {showDeleted ? "恢复" : "删除"}
          </button>
        </div>
      ))}
      {deleting && (
        <Modal
          title="删除草稿？"
          onClose={() => {
            if (!working) setDeleting(null);
          }}
        >
          <h3>{deleting.restaurant_name}</h3>
          <p>删除后可以在「已删除」中恢复。</p>
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={working}
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            <button
              className="primary"
              disabled={working}
              onClick={() => void changeDeleted(deleting, true)}
            >
              {working ? "处理中…" : "删除草稿"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function SourceViewer({
  draft,
  onClose,
}: {
  draft: ImportDraft;
  onClose: () => void;
}) {
  const [prepared, setPrepared] = useState(false);
  return (
    <Modal
      title={draft.source_kind === "text" ? "原始订单文字" : "原始订单截图"}
      onClose={onClose}
      wide
    >
      {draft.source_kind === "text" ? (
        <pre className="original-text">{draft.original_text}</pre>
      ) : (
        <>
          <div className="segmented">
            <button
              className={!prepared ? "selected" : ""}
              onClick={() => setPrepared(false)}
            >
              原始截图
            </button>
            <button
              className={prepared ? "selected" : ""}
              onClick={() => setPrepared(true)}
            >
              识别用图
            </button>
          </div>
          <img
            className="source-image"
            src={`/api/imports/${draft.id}/image?kind=${prepared ? "prepared" : "original"}`}
            alt={prepared ? "用于Gemini识别的已处理截图" : "餐馆原始订单截图"}
          />
          <a
            className="secondary full"
            href={`/api/imports/${draft.id}/image?kind=${prepared ? "prepared" : "original"}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            打开完整大图
          </a>
        </>
      )}
      <button className="primary full" onClick={onClose}>
        返回审核
      </button>
    </Modal>
  );
}

export default function ImportFlow({
  draftId,
  onClose,
  onComplete,
  ...props
}: ViewProps & {
  draftId: string | null;
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const { data, mutate, busy } = props;
  const [id, setId] = useState(draftId);
  const [config, setConfig] = useState<ImportConfig | null>(null);
  const [kind, setKind] = useState<"text" | "image">("text");
  const [restaurantId, setRestaurantId] = useState("");
  const [text, setText] = useState("");
  const [screenshot, setScreenshot] = useState<ScreenshotPayload | null>(null);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [lines, setLines] = useState<ReviewLine[]>([]);
  const [sourceChecked, setSourceChecked] = useState(false);
  const [restaurantAcknowledged, setRestaurantAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [replaceExtraction, setReplaceExtraction] = useState(false);
  const [extractAll, setExtractAll] = useState(false);
  const [forceExtraction, setForceExtraction] = useState(false);
  const [viewSource, setViewSource] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mode, setMode] = useState<ConfirmationMode>("new");
  const [identicalAcknowledged, setIdenticalAcknowledged] = useState(false);
  const [supplement, setSupplement] = useState<string | null>(null);
  const [creatingProduct, setCreatingProduct] = useState<ReviewLine | null>(
    null,
  );
  const [newProduct, setNewProduct] = useState<{
    lineId: string;
    name: string;
  } | null>(null);
  const lock = useRef(false);
  const reviewAnchor = useRef<HTMLDivElement>(null);
  const keys = useRef(new Map<string, string>());
  const initialSourceKey = `fresh-helper-import-input:${data.date}`;
  const [inputReady, setInputReady] = useState(false);

  async function write<T>(url: string, body: unknown): Promise<T> {
    const fingerprint = JSON.stringify(body);
    const key = keys.current.get(fingerprint) ?? clientId();
    keys.current.set(fingerprint, key);
    const result = await api<T>(url, body, key);
    keys.current.delete(fingerprint);
    return result;
  }
  function useDraft(value: ImportDraft, restore = false) {
    setDraft(value);
    setRestaurantId(value.restaurant_id);
    setSourceChecked(value.source_checked);
    setRestaurantAcknowledged(value.restaurant_acknowledged);
    setDirty(false);
    setPreview(null);
    const ordered = [...value.lines].sort(
      (a, b) =>
        Number(lineProblems(b, data.products).length > 0) -
        Number(lineProblems(a, data.products).length > 0),
    );
    if (restore) {
      try {
        const cached = JSON.parse(
          localStorage.getItem(`fresh-helper-review:${value.id}`) ?? "null",
        );
        if (
          cached?.version === value.version &&
          Array.isArray(cached.lines) &&
          cached.lines.length <= 200
        ) {
          setLines(cached.lines);
          setRestaurantId(cached.restaurantId);
          setSourceChecked(cached.sourceChecked);
          setRestaurantAcknowledged(cached.restaurantAcknowledged);
          setDirty(true);
          setMessage("已恢复本机未保存的审核内容，请保存草稿。");
          return;
        }
      } catch {
        /* Server draft remains authoritative. */
      }
    }
    setLines(ordered);
  }
  async function reloadDraft(target = id, restore = false) {
    if (target) {
      const value = await api<ImportDraft>(`/api/imports/${target}`);
      useDraft(value, restore);
      return value;
    }
    return null;
  }
  useEffect(() => {
    let active = true;
    void api<{ config: ImportConfig }>(`/api/imports?date=${data.date}`)
      .then((value) => {
        if (active) setConfig(value.config);
      })
      .catch(() => {
        if (active) setError("未能读取识别配置，仍可保存原稿并手动审核。");
      });
    if (draftId)
      void reloadDraft(draftId, true).catch((e) => setError(e.message));
    else {
      try {
        const raw = JSON.parse(
          localStorage.getItem(initialSourceKey) ?? "null",
        );
        if (raw) {
          setText(typeof raw.text === "string" ? raw.text : "");
          setRestaurantId(
            typeof raw.restaurantId === "string" ? raw.restaurantId : "",
          );
        }
      } catch {}
    }
    setInputReady(true);
    return () => {
      active = false;
    };
    // The flow is scoped to the date at opening; the surrounding dialog is modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!id && inputReady) {
      try {
        localStorage.setItem(
          initialSourceKey,
          JSON.stringify({ restaurantId, text }),
        );
      } catch {}
    }
  }, [id, inputReady, initialSourceKey, restaurantId, text]);
  useEffect(() => {
    if (draft && dirty) {
      try {
        localStorage.setItem(
          `fresh-helper-review:${draft.id}`,
          JSON.stringify({
            version: draft.version,
            lines,
            restaurantId,
            sourceChecked,
            restaurantAcknowledged,
          }),
        );
      } catch {
        setError("本机无法暂存审核内容，请保持窗口打开并点保存草稿。");
      }
    }
  }, [
    draft,
    dirty,
    lines,
    restaurantId,
    sourceChecked,
    restaurantAcknowledged,
  ]);
  useEffect(() => {
    if (newProduct) {
      const product = data.products.find(
        (p) => normalizeName(p.name) === normalizeName(newProduct.name),
      );
      if (product) {
        changeLine(newProduct.lineId, {
          productId: product.id,
          matchedBy: "manual",
        });
        setNewProduct(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newProduct, data.products]);

  async function task(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error && e.message !== "Failed to fetch"
          ? e.message
          : "连接失败，原稿和审核内容仍保留。可安全重试。",
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  function changeLine(lineId: string, patch: Partial<ReviewLine>) {
    setLines((current) =>
      current.map((line) =>
        line.id === lineId
          ? { ...line, ...patch, reviewed: patch.reviewed ?? false }
          : line,
      ),
    );
    setDirty(true);
    setPreview(null);
    setSourceChecked(false);
  }
  function changed() {
    setDirty(true);
    setPreview(null);
  }
  async function saveCurrent() {
    if (!draft) throw new Error("请先读取草稿");
    await write(`/api/imports/${draft.id}`, {
      action: "save",
      version: draft.version,
      restaurantId,
      restaurantAcknowledged,
      sourceChecked,
      lines: lines.map(
        ({
          id,
          productText,
          productId,
          quantity,
          unit,
          disposition,
          ignoreReason,
          reviewed,
          saveAlias,
        }) => ({
          id,
          productText,
          productId,
          quantity,
          unit,
          disposition,
          ignoreReason,
          reviewed,
          saveAlias,
        }),
      ),
    });
    localStorage.removeItem(`fresh-helper-review:${draft.id}`);
    return (await reloadDraft(draft.id))!;
  }
  async function create() {
    if (!restaurantId) throw new Error("请先选择餐馆");
    if (kind === "text" && !text.trim()) throw new Error("请粘贴订单文字");
    if (kind === "image" && !screenshot)
      throw new Error("请选择截图，完成裁剪或遮盖后再保存");
    const result = await write<{ id: string; reused: boolean }>(
      "/api/imports",
      {
        restaurantId,
        date: data.date,
        kind,
        ...(kind === "text"
          ? { text }
          : { original: screenshot!.original, prepared: screenshot!.prepared }),
      },
    );
    setId(result.id);
    localStorage.removeItem(initialSourceKey);
    await reloadDraft(result.id, true);
    setMessage(
      result.reused
        ? "这份内容已有未确认草稿，已打开原草稿，不会重复生成需求。"
        : kind === "text"
          ? "原稿已保存。文字已先用规则和别名匹配，请审核。"
          : "原图已保存，可识别或手动填写。",
    );
  }
  async function extract() {
    if (!draft || !consent) throw new Error("请先阅读数据说明并勾选确认");
    const current = dirty ? await saveCurrent() : draft;
    const result = await write<{
      error?: string;
      cached?: boolean;
      replayed?: boolean;
    }>(`/api/imports/${current.id}`, {
      action: "extract",
      version: current.version,
      privacyVersion: PRIVACY_VERSION,
      redacted: true,
      replaceExisting: replaceExtraction,
      scope: extractAll ? "all" : "unresolved",
      force: forceExtraction,
    });
    setConsent(false);
    setReplaceExtraction(false);
    setForceExtraction(false);
    await reloadDraft(current.id);
    setMessage(
      result.error ??
        (result.cached
          ? "已复用保存的识别结果，未调用 Gemini。请核对。"
          : result.replayed
            ? "没有需要 AI 识别的行，请直接审核。"
            : "已识别，请逐项核对并确认。"),
    );
  }
  const existing = data.orders.find(
    (order) => order.restaurant_id === restaurantId,
  );
  const selectedRestaurant = data.restaurants.find(
    (r) => r.id === restaurantId,
  );
  const mismatch = draft
    ? getMismatch(draft, restaurantId, data.restaurants)
    : [];
  const unresolved = lines.filter(
    (line) => !line.reviewed || lineProblems(line, data.products).length,
  ).length;
  const readOnly = draft?.status === "confirmed";
  const blocked = pending || busy || draft?.status === "extracting" || readOnly;
  const needsReplace =
    (extractAll || draft?.source_kind === "image") &&
    (draft?.lines.some(
      (line) => line.reviewed || line.productId || line.quantity || line.unit,
    ) ??
      false);
  return (
    <Modal
      title={
        !id
          ? "导入餐馆订单"
          : preview
            ? "最后核对 · 不会自动下单"
            : "审核导入订单"
      }
      onClose={() => {
        if (!pending) onClose();
      }}
      wide
    >
      <div className="context-strip">
        <FileText size={20} />
        <strong>{data.date}</strong>
        <span>{selectedRestaurant?.name ?? "请选择餐馆"}</span>
      </div>
      <ErrorText message={error} />
      {message && (
        <div className="inline-note" role="status">
          {message}
        </div>
      )}
      {!id ? (
        <>
          <Field label="餐馆">
            <select
              value={restaurantId}
              onChange={(e) => setRestaurantId(e.target.value)}
              disabled={pending}
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
          <div className="segmented import-kind">
            <button
              className={kind === "text" ? "selected" : ""}
              onClick={() => setKind("text")}
              disabled={pending}
            >
              <FileText size={20} />
              粘贴文字
            </button>
            <button
              className={kind === "image" ? "selected" : ""}
              onClick={() => setKind("image")}
              disabled={pending}
            >
              <ImageIcon size={20} />
              上传截图
            </button>
          </div>
          {kind === "text" ? (
            <Field
              label="餐馆原始订单"
              hint="保留原来的换行。进入审核前请删去电话、个人资料或保密内容。"
            >
              <textarea
                rows={10}
                maxLength={MAX_TEXT_LENGTH}
                placeholder={"fukumiya\n小白菜 300g\n日本timun 2kg\n青龙菜1."}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={pending}
              />
            </Field>
          ) : (
            <ScreenshotEditor onChange={setScreenshot} disabled={pending} />
          )}
          <p className="fine-print">
            先保存原稿到本机，再决定是否发送给 Gemini。不配置密钥也能手动审核。
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={onClose} disabled={pending}>
              返回
            </button>
            <button
              className="primary"
              disabled={
                pending || !restaurantId || (kind === "image" && !screenshot)
              }
              onClick={() => void task(create)}
            >
              <Save size={20} />
              {pending ? "正在保存…" : "保存原稿，进入审核"}
            </button>
          </div>
        </>
      ) : !draft ? (
        <div className="loading-card">
          <p>正在读取草稿…</p>
          <button
            className="secondary"
            onClick={() =>
              void task(async () => {
                await reloadDraft(id, true);
              })
            }
          >
            重新读取
          </button>
        </div>
      ) : preview ? (
        <>
          <button
            className="secondary full"
            onClick={() => setViewSource(true)}
          >
            <Eye size={19} />
            {draft.source_kind === "image" ? "查看原图" : "查看原文"}
          </button>
          <div className="inline-note">
            <strong>
              {preview.restaurantName} · {preview.date}
            </strong>
            <br />
            {preview.mode === "append"
              ? "追加到当天原订单，原单价格保持不变。"
              : preview.mode === "replace"
                ? "替换当天原订单，重新读取当前价格，清除原单实供数量。"
                : "新增当天订单，读取当前标准价格。"}
          </div>
          {preview.mergedRows > 0 && (
            <div className="inline-note">
              已合并 {preview.mergedRows} 个相同商品 /
              相同订购单位的重复项目。不同单位仍分开，请核对以下数量。
            </div>
          )}
          {preview.lines.map((line, index) => (
            <article
              className="preview-import-line"
              key={`${line.productId}:${line.unit}`}
            >
              <strong>
                {index + 1}. {line.name}
              </strong>
              <span>
                {line.quantity} {line.unit}
              </span>
              <small>
                {money(line.price)}
                {line.price !== null ? ` / ${line.billingUnit}` : ""}
                {line.resetsActual ? " · 原实供数量将重置" : ""}
              </small>
            </article>
          ))}
          {preview.missingPrices > 0 && (
            <div className="inline-note">
              有 {preview.missingPrices}{" "}
              项价格待填写。不会当作零元，称重后仍须补齐价格才能完成计费。
            </div>
          )}
          {preview.identicalSource && (
            <div className="inline-error">
              这份原文或截图此前已确认导入，重复追加可能产生双份需求。
              {preview.mode === "append" && (
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={identicalAcknowledged}
                    onChange={(e) => setIdenticalAcknowledged(e.target.checked)}
                  />
                  我确认这是额外订货，需要再次追加数量
                </label>
              )}
            </div>
          )}
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={pending}
              onClick={() => setPreview(null)}
            >
              <ArrowLeft size={18} />
              返回审核
            </button>
            <button
              className="primary"
              disabled={
                pending ||
                (preview.identicalSource &&
                  preview.mode === "append" &&
                  !identicalAcknowledged)
              }
              onClick={() =>
                void task(async () => {
                  await write(`/api/imports/${draft.id}`, {
                    action: "confirm",
                    version: draft.version,
                    token: preview.token,
                    identicalAcknowledged,
                  });
                  localStorage.removeItem(`fresh-helper-review:${draft.id}`);
                  await onComplete();
                })
              }
            >
              <Check size={20} />
              {pending ? "正在确认…" : "确认订单"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="import-source-bar">
            <span className="tag">{draftLabels[draft.status]}</span>
            <button className="secondary" onClick={() => setViewSource(true)}>
              <Eye size={19} />
              {draft.source_kind === "image" ? "查看原图" : "查看原文"}
            </button>
            <button
              className="text-button"
              disabled={pending}
              onClick={() =>
                void task(async () => {
                  if (
                    dirty &&
                    !window.confirm(
                      "重新读取会放弃本机尚未保存的审核更改。是否继续？",
                    )
                  )
                    return;
                  await reloadDraft(draft.id, true);
                })
              }
            >
              <RefreshCw size={17} />
              重新读取
            </button>
          </div>
          {readOnly ? (
            <div className="inline-note">
              此草稿已确认，关联订单已存在。再次打开不会重复生成需求。
            </div>
          ) : (
            <>
              {draft.error_message && (
                <div className="inline-error">{draft.error_message}</div>
              )}
              <details
                className="ai-extraction"
                open={!draft.lines.some((line) => line.productId)}
              >
                <summary>Gemini 识别与免费层数据说明</summary>
                <div className="privacy-notice">
                  <ShieldCheck size={23} />
                  <div>
                    <strong>发送前请先核对隐私</strong>
                    <p>
                      免费 API 的文字、截图和识别结果可能用于 Google
                      产品及模型改进，也可能由人工审核。请勿上传敏感、个人或保密商务信息。
                    </p>
                    <p>
                      只发送本份订单的文字，或已裁剪/遮盖的图片。商品价格和其他餐馆记录不会发送。若内容不适合免费服务，请直接手动审核。
                    </p>
                    <a
                      href="https://ai.google.dev/gemini-api/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      查看 Google 免费服务条款
                    </a>
                  </div>
                </div>
                <p className="fine-print">
                  模型：{config?.model ?? "正在读取配置"} · 本店保护上限{" "}
                  {config?.maxRpm ?? 3} 次/分钟、{config?.maxRpd ?? 20}{" "}
                  次/日。实际 Google 配额以 AI Studio
                  为准，四名员工将共享同一项目配额。
                </p>
                {config && !config.enabled && (
                  <div className="inline-note">
                    {config.reason}。配置方法见 README；不要在这里输入密钥。
                  </div>
                )}
                {draft.source_kind === "text" && (
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={extractAll}
                      disabled={blocked}
                      onChange={(e) => setExtractAll(e.target.checked)}
                    />
                    让 AI 识别整份文字（默认只处理未解决的行）
                  </label>
                )}
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={forceExtraction}
                    disabled={blocked}
                    onChange={(e) => setForceExtraction(e.target.checked)}
                  />
                  跳过已存结果，重新请求 AI（会占用配额）
                </label>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={blocked}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  <span>
                    我已去除敏感内容，了解并同意将此订单发送给 Gemini 免费 API
                  </span>
                </label>
                {needsReplace && (
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={replaceExtraction}
                      disabled={blocked}
                      onChange={(e) => setReplaceExtraction(e.target.checked)}
                    />
                    重新识别成功后会替换当前审核项目；原文/原图仍保留
                  </label>
                )}
                <button
                  className="primary full"
                  disabled={
                    blocked ||
                    !consent ||
                    !config?.enabled ||
                    (needsReplace && !replaceExtraction)
                  }
                  onClick={() => void task(extract)}
                >
                  <RefreshCw size={20} />
                  {pending
                    ? "正在处理，请稍候…"
                    : draft.attempts
                      ? "手动重新识别（不会自动重试）"
                      : "用 Gemini 提取订单"}
                </button>
                <button
                  className="secondary full manual-fallback"
                  disabled={blocked}
                  onClick={() =>
                    reviewAnchor.current?.scrollIntoView({
                      behavior: "smooth",
                      block: "start",
                    })
                  }
                >
                  不使用 AI，直接手动审核
                </button>
              </details>
              <div className="section-heading" ref={reviewAnchor}>
                <h3>逐项审核</h3>
                <span>
                  待处理 {unresolved} / {lines.length}
                </span>
              </div>
              <p className="fine-print">
                缺失字段必须手动填写。每一行都需确认，或明确忽略。内容在编辑时保持原位。
              </p>
              <button
                className="secondary full"
                disabled={blocked}
                onClick={() => {
                  setLines((current) =>
                    current.map((line) =>
                      !line.extractionIssues.length &&
                      !lineProblems(line, data.products).length
                        ? { ...line, reviewed: true }
                        : line,
                    ),
                  );
                  changed();
                }}
              >
                我已核对，确认所有填写完整且无警告的项目
              </button>
              {lines.map((line, index) => {
                const product = data.products.find(
                  (p) => p.id === line.productId,
                );
                const problems = lineProblems(line, data.products);
                const rule = product?.units.find(
                  (u) => u.orderUnit === line.unit,
                );
                const aliasAllowed = Boolean(
                  line.productText &&
                  normalizeName(line.sourceText).includes(
                    normalizeName(line.productText),
                  ) &&
                  product &&
                  normalizeName(product.name) !==
                    normalizeName(line.productText),
                );
                return (
                  <article
                    key={line.id}
                    className={`review-line ${line.reviewed ? "reviewed" : ""}`}
                  >
                    <div className="card-heading">
                      <strong>
                        第 {index + 1} 项{" "}
                        {line.sourceLine
                          ? `· 原文第 ${line.sourceLine} 行`
                          : "· 手动补充"}
                      </strong>
                      <span
                        className={`tag ${line.reviewed ? "green" : "amber"}`}
                      >
                        {line.reviewed
                          ? line.disposition === "ignored"
                            ? "已明确忽略"
                            : "已确认"
                          : "待核对"}
                      </span>
                    </div>
                    {line.sourceText && (
                      <blockquote className="source-line">
                        {line.sourceText}
                      </blockquote>
                    )}
                    {line.extractionIssues.length > 0 && (
                      <div className="review-warnings">
                        {line.extractionIssues.map((issue, i) => (
                          <p key={i}>⚠ {issue}</p>
                        ))}
                      </div>
                    )}
                    {line.matchedBy === "ambiguous" && (
                      <p className="inline-note">
                        这个别名对应多个商品，请人工选择，不会自动合并。
                      </p>
                    )}
                    <div className="review-disposition">
                      <button
                        className={
                          line.disposition === "item" ? "selected" : ""
                        }
                        disabled={blocked}
                        onClick={() =>
                          changeLine(line.id, { disposition: "item" })
                        }
                      >
                        订购项目
                      </button>
                      <button
                        className={
                          line.disposition === "ignored" ? "selected" : ""
                        }
                        disabled={blocked}
                        onClick={() =>
                          changeLine(line.id, {
                            disposition: "ignored",
                            saveAlias: false,
                          })
                        }
                      >
                        明确忽略此行
                      </button>
                    </div>
                    {line.disposition === "ignored" ? (
                      <Field label="忽略原因">
                        <select
                          value={line.ignoreReason}
                          disabled={blocked}
                          onChange={(e) =>
                            changeLine(line.id, {
                              ignoreReason: e.target.value,
                            })
                          }
                        >
                          <option value="">请选择原因</option>
                          <option value="餐馆名称或标题">餐馆名称或标题</option>
                          <option value="无关聊天内容">无关聊天内容</option>
                          <option value="重复内容，已在其他行处理">
                            重复内容，已在其他行处理
                          </option>
                          <option value="已对照原图，另行手动补充">
                            已对照原图，另行手动补充
                          </option>
                          <option value="本次不订购此项">本次不订购此项</option>
                        </select>
                      </Field>
                    ) : (
                      <>
                        <Field label="匹配商品">
                          <select
                            aria-label={`第${index + 1}项匹配商品`}
                            value={line.productId}
                            disabled={blocked}
                            onChange={(e) =>
                              changeLine(line.id, {
                                productId: e.target.value,
                                matchedBy: "manual",
                                saveAlias: false,
                              })
                            }
                          >
                            <option value="">请选择商品，不会自动新建</option>
                            {data.products
                              .filter((p) => p.active)
                              .map((p) => (
                                <option key={p.id} value={p.id}>
                                  {line.candidates.includes(p.id) ? "★ " : ""}
                                  {p.name}
                                </option>
                              ))}
                          </select>
                        </Field>
                        <button
                          className="text-button"
                          disabled={
                            blocked || !data.zones.some((z) => z.active)
                          }
                          onClick={() => setCreatingProduct(line)}
                        >
                          <Plus size={18} />
                          没有这个商品？现在新建
                        </button>
                        <div className="quantity-row">
                          <Field label="订购数量">
                            <input
                              aria-label={`第${index + 1}项订购数量`}
                              inputMode="decimal"
                              value={line.quantity}
                              disabled={blocked}
                              onChange={(e) =>
                                changeLine(line.id, {
                                  quantity: e.target.value,
                                })
                              }
                              placeholder="缺失时请填写"
                              maxLength={12}
                            />
                          </Field>
                          <Field label="订购单位">
                            <select
                              aria-label={`第${index + 1}项订购单位`}
                              value={line.unit}
                              disabled={blocked}
                              onChange={(e) =>
                                changeLine(line.id, {
                                  unit: e.target.value as Unit,
                                })
                              }
                            >
                              <option value="">请选择</option>
                              {line.unit &&
                                !product?.units.some(
                                  (u) => u.orderUnit === line.unit,
                                ) && (
                                  <option value={line.unit}>
                                    {line.unit}（待核对）
                                  </option>
                                )}
                              {product?.units.map((u) => (
                                <option key={u.orderUnit} value={u.orderUnit}>
                                  {u.orderUnit}
                                </option>
                              ))}
                            </select>
                          </Field>
                        </div>
                        {rule && (
                          <p className="item-meta">
                            标准售价：{money(rule.price)}
                            {rule.price !== null
                              ? ` / ${rule.billingUnit}`
                              : ""}{" "}
                            · 由应用读取，不由 AI 提供
                          </p>
                        )}
                        {line.sourceText && product && (
                          <details className="alias-details">
                            <summary>原文叫法 / 保存别名</summary>
                            <Field
                              label="原文商品叫法（选填）"
                              hint="只能使用本行原文中确实出现的叫法。"
                            >
                              <input
                                value={line.productText}
                                disabled={blocked}
                                maxLength={80}
                                onChange={(e) =>
                                  changeLine(line.id, {
                                    productText: e.target.value,
                                    saveAlias: false,
                                  })
                                }
                              />
                            </Field>
                            {aliasAllowed && (
                              <label className="check-line">
                                <input
                                  type="checkbox"
                                  checked={line.saveAlias}
                                  disabled={blocked}
                                  onChange={(e) =>
                                    changeLine(line.id, {
                                      saveAlias: e.target.checked,
                                    })
                                  }
                                />
                                确认订单时，将「{line.productText}
                                」保存为此商品的别名
                              </label>
                            )}
                          </details>
                        )}
                      </>
                    )}
                    {!line.reviewed && problems.length > 0 && (
                      <p className="review-problems">{problems.join("；")}</p>
                    )}
                    <button
                      className={
                        line.reviewed ? "secondary full" : "primary full"
                      }
                      disabled={blocked || problems.length > 0}
                      onClick={() =>
                        changeLine(line.id, { reviewed: !line.reviewed })
                      }
                    >
                      <Check size={19} />
                      {line.reviewed
                        ? "重新编辑此项"
                        : line.disposition === "ignored"
                          ? "确认忽略这一行"
                          : "我已核对，确认此项"}
                    </button>
                  </article>
                );
              })}
              {!lines.length && (
                <div className="inline-note">
                  尚无可读项目。可用 Gemini 识别，或手动添加，原图始终保留。
                </div>
              )}
              <div className="manual-import-actions">
                <button
                  className="secondary"
                  disabled={blocked || lines.length >= 200}
                  onClick={() => {
                    setLines((current) => [
                      ...current,
                      blankLine("", 0, `manual-${clientId()}`),
                    ]);
                    changed();
                    setSourceChecked(false);
                  }}
                >
                  <Plus size={19} />
                  手动加一项
                </button>
                <button
                  className="secondary"
                  disabled={blocked}
                  onClick={() => setSupplement("")}
                >
                  <FileText size={19} />
                  粘贴补充文字
                </button>
              </div>
              {supplement !== null && (
                <div className="supplement-box">
                  <Field label="补充订单文字">
                    <textarea
                      value={supplement}
                      rows={4}
                      maxLength={MAX_TEXT_LENGTH}
                      onChange={(e) => setSupplement(e.target.value)}
                    />
                  </Field>
                  <p className="fine-print">
                    每个非空行都会加入审核；原有内容不删除，也不会发送给 AI。
                  </p>
                  <button
                    className="secondary full"
                    disabled={blocked || !supplement.trim()}
                    onClick={() =>
                      void task(async () => {
                        const saved = await saveCurrent();
                        await write(`/api/imports/${saved.id}`, {
                          action: "supplement",
                          version: saved.version,
                          text: supplement,
                        });
                        setSupplement(null);
                        await reloadDraft(saved.id);
                      })
                    }
                  >
                    保存补充文字到审核列表
                  </button>
                </div>
              )}
              <div className="review-final-check">
                <Field label="最终对应餐馆">
                  <select
                    value={restaurantId}
                    disabled={blocked}
                    onChange={(e) => {
                      setRestaurantId(e.target.value);
                      setRestaurantAcknowledged(false);
                      changed();
                    }}
                  >
                    {data.restaurants
                      .filter((r) => r.active)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                  </select>
                </Field>
                {mismatch.length > 0 && (
                  <div className="inline-error">
                    原文检测到「{mismatch.join(" / ")}
                    」，与当前餐馆可能不一致。请改选餐馆，或明确保留当前选择。
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={restaurantAcknowledged}
                        disabled={blocked}
                        onChange={(e) => {
                          setRestaurantAcknowledged(e.target.checked);
                          changed();
                        }}
                      />
                      我已核对，仍应归入「{selectedRestaurant?.name}」
                    </label>
                  </div>
                )}
                {draft.extraction_warning && (
                  <p className="inline-note">
                    截图可能存在漏识别或不可读内容。请逐字对照原图，补齐遗漏后再确认。
                  </p>
                )}
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={sourceChecked}
                    disabled={blocked}
                    onChange={(e) => {
                      setSourceChecked(e.target.checked);
                      changed();
                    }}
                  />
                  我已对照原文 / 原图，确认所有订购内容都已处理，没有遗漏
                </label>
                {existing ? (
                  <>
                    <div className="inline-note">
                      「{existing.restaurant_name}」在 {data.date} 已有订单。
                      {existing.picking_started_at
                        ? "已开始配货，禁止追加或替换。"
                        : "请明确选择追加或替换。"}
                    </div>
                    <Field label="已有订单处理方式">
                      <select
                        value={mode === "new" ? "" : mode}
                        disabled={blocked || !!existing.picking_started_at}
                        onChange={(e) =>
                          setMode(e.target.value as ConfirmationMode)
                        }
                      >
                        <option value="">请选择，不会自动追加</option>
                        <option value="append">追加数量（保留原单价格）</option>
                        <option value="replace">
                          替换原单（重新读取现价）
                        </option>
                      </select>
                    </Field>
                  </>
                ) : (
                  <p className="fine-print">
                    此餐馆当天没有订单，将新增一份订单。
                  </p>
                )}
                <div className="modal-actions">
                  <button
                    className="secondary"
                    disabled={blocked}
                    onClick={() =>
                      void task(async () => {
                        await saveCurrent();
                        setMessage(
                          "审核草稿已保存到服务端，尚未生成配货任务。",
                        );
                      })
                    }
                  >
                    <Save size={19} />
                    {dirty ? "保存草稿" : "保存审核"}
                  </button>
                  <button
                    className="primary"
                    disabled={
                      blocked ||
                      unresolved > 0 ||
                      !sourceChecked ||
                      (mismatch.length > 0 && !restaurantAcknowledged) ||
                      !!existing?.picking_started_at ||
                      (!!existing && mode === "new")
                    }
                    onClick={() =>
                      void task(async () => {
                        const saved = await saveCurrent();
                        const value = await api<ImportPreview>(
                          `/api/imports/${saved.id}`,
                          {
                            action: "preview",
                            version: saved.version,
                            mode: existing ? mode : "new",
                          },
                        );
                        setIdenticalAcknowledged(false);
                        setPreview(value);
                      })
                    }
                  >
                    核对最终订单 →
                  </button>
                </div>
                <p className="draft-note">
                  {dirty
                    ? "当前更改尚未保存到服务端；本机已暂存。"
                    : "服务端草稿已保存。"}
                  只有最终确认后才生成配货任务。
                </p>
              </div>
            </>
          )}
        </>
      )}
      {viewSource && draft && (
        <SourceViewer draft={draft} onClose={() => setViewSource(false)} />
      )}
      {creatingProduct && (
        <ProductEditor
          {...props}
          initialName={creatingProduct.productText || undefined}
          onSaved={(name) =>
            setNewProduct({ lineId: creatingProduct.id, name })
          }
          onClose={() => setCreatingProduct(null)}
        />
      )}
    </Modal>
  );
}

function getMismatch(
  draft: ImportDraft,
  restaurantId: string,
  restaurants: { id: string; name: string; aliases: string[] }[],
) {
  const evidence = draft.original_text.split(/\r?\n/).map(normalizeName);
  const detected = normalizeName(draft.detected_restaurant ?? "");
  const selected = restaurants.find((r) => r.id === restaurantId);
  const others = restaurants
    .filter(
      (r) =>
        r.id !== restaurantId &&
        [r.name, ...r.aliases].some(
          (n) =>
            evidence.includes(normalizeName(n)) ||
            normalizeName(n) === detected,
        ),
    )
    .map((r) => r.name);
  if (
    detected &&
    selected &&
    ![selected.name, ...selected.aliases].some(
      (n) => normalizeName(n) === detected,
    )
  )
    others.push(draft.detected_restaurant!);
  return [...new Set(others)];
}

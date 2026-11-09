"use client";
import { uploadPrivateFile } from "@/lib/file-transfer.client";
import { waitCloudJob } from "@/lib/cloud-jobs.client";
import { startFileRequest } from "@/lib/cloud-request.client";
import { downloadTicket } from "@/lib/file-transfer.client";
import { useEffect, useState } from "react";
import { ErrorText, Field, Modal } from "./ui";
type Preview = {
  token: string;
  shopName: string;
  exportedAt: string;
  orders: number;
  products: number;
  documents: number;
};
export default function BackupRestore() {
  const [health, setHealth] = useState<{
    enabled: boolean;
    lastSuccess: string | null;
    error: string | null;
    cloud?: boolean;
    bytes?: number;
    records?: { id: string; kind: string; created_at: string }[];
  } | null>(null);
  const [healthError, setHealthError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const r = await fetch("/api/backup/status", {
          cache: "no-store",
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) throw new Error();
        const value = await r.json();
        if (!cancelled) {
          setHealth(value);
          setHealthError("");
        }
      } catch {
        if (!cancelled) setHealthError("未能读取自动备份状态，请检查连接。");
      }
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, []);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [checked, setChecked] = useState(false);
  const [done, setDone] = useState("");
  async function request(body: unknown) {
    const response = await startFileRequest("/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return response.status === 202 ? await waitCloudJob(value) : value;
  }
  async function select(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    setPreview(null);
    setChecked(false);
    setName("");
    try {
      if (file.size > 128 * 1024 * 1024)
        throw new Error("备份最大 128MB，请使用完整数据目录备份方式。");
      const uploadId = await uploadPrivateFile(
        new Blob([file], { type: "application/json" }),
        "backup",
      );
      if (uploadId) setPreview(await request({ action: "preview", uploadId }));
      else {
        const backup = JSON.parse(await file.text());
        setPreview(await request({ action: "preview", backup }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法读取备份文件");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="restore-box">
      <h3>自动备份</h3>
      {health && (
        <p>
          {health.enabled
            ? "已开启，每天一份"
            : health.cloud
              ? "未开启，云端测试后再启用每日快照"
              : "未开启，请先配置服务器备份目录及开关"}
        </p>
      )}
      {health?.lastSuccess && (
        <p>
          最近成功：
          {new Date(health.lastSuccess).toLocaleString("zh-CN", {
            timeZone: "Asia/Kuala_Lumpur",
          })}
        </p>
      )}
      {health?.enabled && !health.lastSuccess && !health.error && (
        <p>等待首次备份，请稍后确认文件已生成。</p>
      )}
      <ErrorText message={health?.error || healthError} />
      {health?.cloud && (
        <>
          <p className="fine-print">
            云内快照与原文件保存在同一服务，请另行下载完整备份。
          </p>
          <p>文件用量：{((health.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB</p>
          {!!health.records?.length && (
            <details>
              <summary>最近云内快照</summary>
              {health.records.map((record) => (
                <button
                  key={record.id}
                  className="secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const r = await startFileRequest(
                        `/api/backup?backupId=${encodeURIComponent(record.id)}`,
                        { cache: "no-store" },
                      );
                      const value = await r.json();
                      if (!r.ok) throw new Error(value.error);
                      await downloadTicket(await waitCloudJob(value));
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {new Date(record.created_at).toLocaleString("zh-CN", {
                    timeZone: "Asia/Kuala_Lumpur",
                  })}{" "}
                  · {record.kind === "safety" ? "恢复前" : "每日"} · 下载
                </button>
              ))}
            </details>
          )}
        </>
      )}
      <h3>恢复备份</h3>
      <p className="fine-print">
        先验证文件，再确认替换。恢复前自动保存一份现有资料；登录密码保持不变。
      </p>
      <Field label="选择 JSON 备份">
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy || !!done}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void select(file);
          }}
        />
      </Field>
      {busy && <p>正在验证或恢复，请保持页面打开…</p>}
      <ErrorText message={error} />
      {done && (
        <div className="inline-note">
          <p>恢复完成，请重新登录。</p>
          <p>恢复前备份：{done}</p>
          <button className="primary" onClick={() => window.location.reload()}>
            重新登录
          </button>
        </div>
      )}
      {preview && (
        <Modal
          title="确认恢复备份"
          onClose={() => {
            if (!busy) setPreview(null);
          }}
        >
          <h3>{preview.shopName}</h3>
          <p>
            订单 {preview.orders} 份 · 商品 {preview.products} 个 · 送货单{" "}
            {preview.documents} 份
          </p>
          <p>
            导出时间：
            {new Date(preview.exportedAt).toLocaleString("zh-CN", {
              timeZone: "Asia/Kuala_Lumpur",
            })}
          </p>
          <p className="inline-error">
            会替换现有全部日期资料，并清除本机未提交输入。此操作不会更换登录密码。
          </p>
          <Field label="输入备份中的店名确认">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </Field>
          <label className="check-line">
            <input
              type="checkbox"
              checked={checked}
              disabled={busy}
              onChange={(e) => setChecked(e.target.checked)}
            />
            确认用此备份替换现有资料
          </label>
          <ErrorText message={error} />
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              取消
            </button>
            <button
              className="primary"
              disabled={busy || !checked || name !== preview.shopName}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const result = await request({
                    action: "confirm",
                    token: preview.token,
                    shopName: name,
                    confirm: true,
                  });
                  for (const key of Object.keys(localStorage))
                    if (
                      key.startsWith("fresh-helper-") ||
                      key.startsWith("fresh-helper:")
                    ) {
                      if (key !== "fresh-helper-font-size")
                        localStorage.removeItem(key);
                    }
                  setDone(result.safetyFile);
                  setPreview(null);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "恢复中…" : "确认替换并恢复"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

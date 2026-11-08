"use client";
import { useEffect, useState } from "react";
import type { CurrentUser } from "@/lib/permissions";
import type { ViewProps } from "./types";
import { ErrorText, Field, Modal } from "./ui";
type Staff = CurrentUser & { active: boolean; version: number };
export default function StaffSettings({ mutate, busy, error }: ViewProps) {
  const [users, setUsers] = useState<Staff[]>([]);
  const [edit, setEdit] = useState<Partial<Staff> | null>(null);
  const [password, setPassword] = useState("");
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/users", { cache: "no-store" })
      .then(async (r) => {
        const value = await r.json();
        if (!r.ok) throw new Error(value.error);
        if (!cancelled) {
          setUsers(value.users);
          setLoadError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);
  return (
    <section className="panel">
      <div className="card-heading">
        <h2>员工账号</h2>
        <button
          className="primary"
          onClick={() => {
            setEdit({
              name: "",
              username: "",
              active: true,
              can_import: false,
              can_finalize: false,
            });
            setPassword("");
          }}
        >
          添加员工
        </button>
      </div>
      <ErrorText message={loadError} />
      {users.map((user) => (
        <div className="staff-row" key={user.id}>
          <div>
            <strong>{user.name}</strong>
            <p>
              {user.username} ·{" "}
              {user.role === "staff"
                ? user.active
                  ? "员工"
                  : "已停用"
                : "店主"}
            </p>
          </div>
          {user.role === "staff" && (
            <button
              className="secondary"
              onClick={() => {
                setEdit(user);
                setPassword("");
              }}
            >
              编辑权限
            </button>
          )}
        </div>
      ))}
      <p className="fine-print">
        员工可配货及称重；导入和定稿须单独授权。修改权限或密码后，该员工需重新登录。
      </p>
      {edit && (
        <Modal
          title={edit.id ? "编辑员工" : "添加员工"}
          onClose={() => {
            if (!busy) setEdit(null);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await mutate(
                  {
                    action: "saveStaff",
                    ...(edit.id ? { id: edit.id, version: edit.version } : {}),
                    name: edit.name,
                    username: edit.username,
                    active: !!edit.active,
                    canImport: !!edit.can_import,
                    canFinalize: !!edit.can_finalize,
                    ...(password ? { password } : {}),
                  },
                  "员工账号已保存",
                )
              ) {
                setEdit(null);
                setPassword("");
                setRevision((v) => v + 1);
              }
            }}
          >
            <Field label="姓名">
              <input
                required
                maxLength={40}
                value={edit.name ?? ""}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </Field>
            <Field label="登录名" hint="3至32位英文或数字，可含 _ 和 -">
              <input
                autoComplete="off"
                required
                pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}"
                maxLength={32}
                value={edit.username ?? ""}
                onChange={(e) => setEdit({ ...edit, username: e.target.value })}
              />
            </Field>
            <Field label={edit.id ? "新密码（不改则留空）" : "设置密码"}>
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required={!edit.id}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <label className="check-line">
              <input
                type="checkbox"
                checked={!!edit.active}
                onChange={(e) => setEdit({ ...edit, active: e.target.checked })}
              />
              启用账号
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                checked={!!edit.can_import}
                onChange={(e) =>
                  setEdit({ ...edit, can_import: e.target.checked })
                }
              />
              允许导入及录单
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                checked={!!edit.can_finalize}
                onChange={(e) =>
                  setEdit({ ...edit, can_finalize: e.target.checked })
                }
              />
              允许定稿 PDF
            </label>
            <ErrorText message={error} />
            <button className="primary full" disabled={busy}>
              {busy ? "保存中…" : "保存账号"}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}

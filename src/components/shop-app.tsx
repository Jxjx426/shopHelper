"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClipboardList,
  Layers,
  Scale,
  Settings,
  Leaf,
  ChevronLeft,
  ChevronRight,
  LogOut,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  WifiOff,
  Download,
} from "lucide-react";
import { todayMalaysia, type Workspace } from "@/lib/domain";
import { clientId } from "@/lib/client-id";
import { Field, ErrorText } from "./ui";
import Orders from "./orders";
import Picking from "./picking";
import Weighing from "./weighing";
import ShopSettings from "./settings";
import { FontSetting, useFontSize } from "./font-setting";
import type { CurrentUser } from "@/lib/permissions";
import { retryKey, forgetRetry } from "@/lib/retry-ledger";
import {
  startWorkspaceSync,
  type SyncHealth,
} from "@/lib/workspace-sync.client";
type Auth = { configured: boolean; user: CurrentUser | null };
type Tab = "orders" | "picking" | "weighing" | "settings";
const tabs = [
  { id: "orders", label: "今日订单", icon: ClipboardList },
  { id: "picking", label: "配货", icon: Layers },
  { id: "weighing", label: "称重出单", icon: Scale },
  { id: "settings", label: "设置", icon: Settings },
] as const;
async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
    ...init,
  });
  const body = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(body.error ?? "操作失败，请重试"), {
      status: response.status,
    });
  return body;
}
export default function ShopApp() {
  const fontPreference = useFontSize();
  const [auth, setAuth] = useState<Auth | null>(null);
  const [authError, setAuthError] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("owner");
  const [shopName, setShopName] = useState("");
  const [date, setDate] = useState(todayMalaysia);
  const dateRef = useRef(date);
  dateRef.current = date;
  const [tab, setTab] = useState<Tab>("orders");
  const [data, setData] = useState<Workspace | null>(null);
  const workspaceRef = useRef<Workspace | null>(null);
  workspaceRef.current = data;
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [online, setOnline] = useState(true);
  const [connected, setConnected] = useState(true);
  const [pending, setPending] = useState(false);
  const loadSequence = useRef(0);
  const etags = useRef(new Map<string, string>());
  const [syncHealth, setSyncHealth] = useState<SyncHealth>("connecting");
  const failedRequests = useRef(new Map<string, string>());
  const mutationLock = useRef(false);
  const load = useCallback(async (selected: string, silent = false) => {
    const sequence = ++loadSequence.current;
    if (!silent) setLoading(true);
    try {
      const response = await fetch(`/api/workspace?date=${selected}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
        headers:
          workspaceRef.current?.date === selected && etags.current.has(selected)
            ? { "If-None-Match": etags.current.get(selected)! }
            : {},
      });
      if (response.status === 304) {
        if (sequence === loadSequence.current) setConnected(true);
        return;
      }
      const value = await response.json();
      if (!response.ok)
        throw Object.assign(new Error(value.error), {
          status: response.status,
        });
      if (response.headers.get("ETag"))
        etags.current.set(selected, response.headers.get("ETag")!);
      if (sequence === loadSequence.current && dateRef.current === selected) {
        setConnected(true);
        setData((previous) =>
          JSON.stringify(previous) === JSON.stringify(value) ? previous : value,
        );
      }
    } catch (e) {
      if (sequence === loadSequence.current) setConnected(false);
      if ((e as { status?: number }).status === 401)
        setAuth((previous) => (previous ? { ...previous, user: null } : null));
      throw e;
    } finally {
      if (sequence === loadSequence.current && dateRef.current === selected)
        setLoading(false);
    }
  }, []);
  const checkAuth = useCallback(async () => {
    try {
      setAuth(await request("/api/auth"));
      setAuthError("");
    } catch {
      setAuthError("无法连接店铺，请检查网络或服务后重试。");
    }
  }, []);
  useEffect(() => {
    void checkAuth();
    const up = () => setOnline(true),
      down = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, [checkAuth]);
  useEffect(() => {
    if (auth?.user)
      void load(date).catch((e) =>
        setNotice({ text: e.message ?? "加载失败，请重试", error: true }),
      );
  }, [auth?.user, date, load]);
  useEffect(() => {
    if (!auth?.user) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (mutationLock.current) {
        timer = setTimeout(flush, 300);
        return;
      }
      void load(dateRef.current, true).catch(() => {});
    };
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 300);
    };
    const stop = startWorkspaceSync(
      refresh,
      (health) => {
        setSyncHealth(health);
        if (health === "offline") setConnected(false);
        else if (health === "live" || health === "slow") setConnected(true);
      },
      () =>
        setAuth((previous) => (previous ? { ...previous, user: null } : null)),
    );
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [auth?.user?.id, load]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab, date]);
  async function logout() {
    try {
      await request("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
      setData(null);
      loadSequence.current++;
      etags.current.clear();
      failedRequests.current.clear();
      setPending(false);
      await checkAuth();
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
    }
  }
  async function mutate(action: Record<string, unknown>, success = "已保存") {
    if (mutationLock.current) return false;
    if (!navigator.onLine || !connected) {
      setPending(true);
      setNotice({
        text: "网络已断开，尚未保存。输入仍保留，请连接后重试。",
        error: true,
      });
      return false;
    }
    mutationLock.current = true;
    setBusy(true);
    setNotice(null);
    const fingerprint = JSON.stringify(action);
    let requestId = failedRequests.current.get(fingerprint) ?? clientId();
    if (action.action !== "saveStaff" && auth?.user) {
      try {
        requestId = retryKey(
          localStorage,
          `${auth.user.id}:${data?.generation}`,
          fingerprint,
          () => requestId,
        );
      } catch {
        /* In-memory retry identity remains available on this page. */
      }
    }
    failedRequests.current.set(fingerprint, requestId);
    try {
      await request("/api/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestId,
        },
        body: JSON.stringify(action),
      });
      failedRequests.current.delete(fingerprint);
      if (auth?.user)
        forgetRetry(
          localStorage,
          `${auth.user.id}:${data?.generation}`,
          fingerprint,
        );
      setPending(false);
      setNotice({ text: success, error: false });
      try {
        await load(dateRef.current);
      } catch {
        setNotice({
          text: "已保存到数据库，但列表刷新失败。请点击重新加载。",
          error: true,
        });
      }
      return true;
    } catch (e) {
      const error = e as Error & { status?: number };
      if (error.status && error.status < 500)
        failedRequests.current.delete(fingerprint);
      if (error.status && error.status < 500 && auth?.user)
        forgetRetry(
          localStorage,
          `${auth.user.id}:${data?.generation}`,
          fingerprint,
        );
      setPending(true);
      if (!error.status || error.status >= 500) setConnected(false);
      if (error.status === 409) {
        try {
          await load(dateRef.current, true);
        } catch {
          /* Keep the conflict and local input visible. */
        }
      }
      if (error.status === 401)
        setAuth((previous) => (previous ? { ...previous, user: null } : null));
      setNotice({
        text:
          error.message === "Failed to fetch"
            ? "连接失败，尚未确认保存。输入仍保留，可安全重试。"
            : error.message,
        error: true,
      });
      return false;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setAuthError("");
    try {
      await request("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: auth?.configured ? "login" : "setup",
          password,
          username,
          shopName,
        }),
      });
      setPassword("");
      setData(null);
      loadSequence.current++;
      etags.current.clear();
      failedRequests.current.clear();
      setPending(false);
      await checkAuth();
    } catch (e) {
      setAuthError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function shiftDate(amount: number) {
    const next = new Date(`${date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + amount);
    setDate(next.toISOString().slice(0, 10));
    setNotice(null);
  }
  if (!auth || !auth.user)
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div className="brand-symbol">
            <Leaf size={34} />
          </div>
          <h1>鲜配助手</h1>
          <FontSetting {...fontPreference} />
          <p className="auth-description">
            {auth?.configured
              ? "使用自己的账号登录。店主登录名为 owner。"
              : "设置店名和店主密码。"}
          </p>
          {!auth ? (
            <>
              <ErrorText message={authError} />
              <button
                className="primary"
                disabled={!authError}
                onClick={() => void checkAuth()}
              >
                {authError ? "重新连接" : "正在连接店铺…"}
              </button>
            </>
          ) : (
            <form onSubmit={login}>
              {!auth.configured && (
                <Field label="店名">
                  <input
                    autoComplete="organization"
                    required
                    maxLength={80}
                    value={shopName}
                    onChange={(e) => setShopName(e.target.value)}
                    placeholder="例如：永兴菜行"
                  />
                </Field>
              )}
              {auth.configured && (
                <Field label="登录名">
                  <input
                    autoComplete="username"
                    required
                    maxLength={32}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
              )}
              <Field
                label={auth.configured ? "密码" : "设置店主密码"}
                hint={!auth.configured ? "至少8位，请妥善保管。" : undefined}
              >
                <input
                  type="password"
                  autoComplete={
                    auth.configured ? "current-password" : "new-password"
                  }
                  minLength={8}
                  maxLength={128}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <ErrorText message={authError} />
              <button className="primary full" disabled={busy}>
                {busy ? "请稍候…" : auth.configured ? "进入店铺" : "保存并开始"}
              </button>
            </form>
          )}
          <div className="edition-note">
            第 4 阶段 · 店铺共享版
            <br />
            订单保存在店铺服务器；AI 导入需先确认数据说明
          </div>
        </div>
      </main>
    );
  const viewData = data?.date === date ? data : null;
  const viewError = notice?.error ? notice.text : "";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="鲜配助手首页">
          <div className="brand-symbol">
            <Leaf />
          </div>
          <div>
            <strong>鲜配助手</strong>
            <span>{data?.shop.name ?? "每日配货助手"}</span>
          </div>
        </a>
        <div className="side-label">店铺工作台</div>
        <nav className="desktop-nav" aria-label="主要导航">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => {
                setTab(id);
                setNotice(null);
              }}
              className={tab === id ? "active" : ""}
              aria-current={tab === id ? "page" : undefined}
            >
              <Icon size={23} />
              {label}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="local-badge">
            <span />
            {auth.user.name}
          </div>
          <button className="text-button" onClick={() => void logout()}>
            <LogOut size={18} />
            退出账号
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="mobile-brand">
            <Leaf size={25} />
            <strong>{data?.shop.name ?? "鲜配助手"}</strong>
          </div>
          <div className="date-control">
            <span className="date-caption">送货日期</span>
            <button
              aria-label="前一天"
              onClick={() => shiftDate(-1)}
              disabled={busy}
            >
              <ChevronLeft />
            </button>
            <input
              type="date"
              aria-label="送货日期"
              value={date}
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) {
                  setDate(e.target.value);
                  setNotice(null);
                }
              }}
            />
            <button
              aria-label="后一天"
              onClick={() => shiftDate(1)}
              disabled={busy}
            >
              <ChevronRight />
            </button>
            <button
              className="today-button"
              onClick={() => setDate(todayMalaysia())}
              disabled={busy}
            >
              今天
            </button>
          </div>
          <div className="connection">
            <span
              className={`status-dot ${!online || !connected ? "offline" : ""}`}
            />
            <span>
              {auth.user.name} ·{" "}
              {!online || !connected
                ? "连接已断开"
                : busy
                  ? "保存中…"
                  : pending
                    ? "未保存"
                    : syncHealth === "live"
                      ? "已同步"
                      : syncHealth === "slow"
                        ? "同步较慢"
                        : syncHealth === "connecting"
                          ? "正在连接…"
                          : "等待连接"}
            </span>
          </div>
        </header>
        <main className="workspace">
          {(!online || !connected) && (
            <div className="notice error" role="alert">
              <WifiOff size={22} />
              连接已断开，不能提交。未保存的输入仍保留。
            </div>
          )}
          {notice && (
            <div
              className={`notice ${notice.error ? "error" : "success"}`}
              role={notice.error ? "alert" : "status"}
            >
              {notice.error ? (
                <AlertCircle size={22} />
              ) : (
                <CheckCircle2 size={22} />
              )}
              <span>{notice.text}</span>
              {notice.error && (
                <button
                  onClick={() =>
                    void load(date).catch((e) =>
                      setNotice({ text: e.message, error: true }),
                    )
                  }
                  disabled={busy}
                >
                  <RefreshCw size={18} />
                  重新加载
                </button>
              )}
            </div>
          )}
          {!viewData ? (
            <div className="loading-card">
              <RefreshCw className={loading ? "spin" : ""} />
              <h2>{loading ? "正在读取当天订单…" : "未能读取订单"}</h2>
              {!loading && (
                <button
                  className="primary"
                  onClick={() =>
                    void load(date).catch((e) =>
                      setNotice({ text: e.message, error: true }),
                    )
                  }
                >
                  重新加载
                </button>
              )}
            </div>
          ) : tab === "orders" ? (
            <Orders
              onDateChange={setDate}
              onReload={() => load(date)}
              data={viewData}
              mutate={mutate}
              busy={busy}
              error={viewError}
              onSettings={() => setTab("settings")}
            />
          ) : tab === "picking" ? (
            <Picking
              data={viewData}
              mutate={mutate}
              busy={busy}
              error={viewError}
            />
          ) : tab === "weighing" ? (
            <Weighing
              data={viewData}
              mutate={mutate}
              busy={busy}
              error={viewError}
            />
          ) : (
            <ShopSettings
              {...fontPreference}
              onLogout={logout}
              data={viewData}
              mutate={mutate}
              busy={busy}
              error={viewError}
            />
          )}
        </main>
        <footer className="workspace-footer">
          <Leaf size={16} /> 鲜配助手 · 第 4 阶段
          <span>手动录单 · 配货 · 称重</span>
        </footer>
      </div>
      <nav className="mobile-nav" aria-label="手机主要导航">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setNotice(null);
            }}
            className={tab === id ? "active" : ""}
            aria-current={tab === id ? "page" : undefined}
          >
            <Icon size={23} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

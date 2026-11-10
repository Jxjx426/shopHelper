"use client";
import { startFileRequest } from "@/lib/cloud-request.client";
import { waitCloudJob } from "@/lib/cloud-jobs.client";
import { downloadTicket } from "@/lib/file-transfer.client";
import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Plus,
  Pencil,
  Store,
  Layers,
  Package,
  Settings,
  Download,
  Check,
  Trash2,
  ShieldCheck,
  LogOut,
} from "lucide-react";
import {
  UNITS,
  UNIT_LABELS,
  isWeight,
  money,
  type Product,
  type Restaurant,
  type Unit,
  type UnitRule,
  type Zone,
} from "@/lib/domain";
import { Empty, ErrorText, Field, Modal } from "./ui";
import type { ViewProps } from "./types";
import { FontSetting, type FontSize } from "./font-setting";
import { RestaurantPrices, ThresholdSettings } from "./billing-settings";
import BackupRestore from "./backup-restore";
import StaffSettings from "./staff-settings";
import { allowed } from "@/lib/permissions";
const splitAliases = (value: string) => [
  ...new Set(
    value
      .split(/[\n,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
type Editor =
  | { kind: "zone"; value?: Zone }
  | { kind: "restaurant"; value?: Restaurant }
  | { kind: "product"; value?: Product };

function BasicEditor({
  editor,
  onClose,
  ...props
}: ViewProps & {
  editor: Exclude<Editor, { kind: "product" }>;
  onClose: () => void;
}) {
  const { data, mutate, busy, error } = props;
  const [name, setName] = useState(editor.value?.name ?? "");
  const [aliases, setAliases] = useState(
    editor.kind === "restaurant"
      ? (editor.value?.aliases.join("\n") ?? "")
      : "",
  );
  const [active, setActive] = useState(editor.value?.active ?? true);
  const zoneHasProducts =
    editor.kind === "zone" &&
    data.products.some((p) => p.active && p.zone_id === editor.value?.id);
  const label = editor.kind === "zone" ? "区域" : "餐馆";
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const action = {
      action: editor.kind === "zone" ? "saveZone" : "saveRestaurant",
      ...(editor.value
        ? { id: editor.value.id, version: editor.value.version }
        : {}),
      name,
      active,
      ...(editor.kind === "restaurant"
        ? { aliases: splitAliases(aliases) }
        : {}),
    };
    if (await mutate(action, `${label}已保存`)) onClose();
  }
  return (
    <Modal
      title={`${editor.value ? "编辑" : "添加"}${label}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={save}>
        <Field label={`${label}名称`}>
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              editor.kind === "zone" ? "例如：豆腐区" : "例如：大福屋"
            }
          />
        </Field>
        {editor.kind === "restaurant" && (
          <Field
            label="已确认别名（选填）"
            hint="每行一个，或用逗号分隔。用于导入时核对餐馆名称。"
          >
            <textarea
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              rows={3}
              maxLength={4800}
              placeholder="例如：fukumiya"
            />
          </Field>
        )}
        <Field label="状态">
          <select
            value={active ? "active" : "inactive"}
            onChange={(e) => setActive(e.target.value === "active")}
          >
            <option value="active">启用</option>
            <option value="inactive" disabled={!!zoneHasProducts}>
              停用
            </option>
          </select>
        </Field>
        {zoneHasProducts && (
          <p className="inline-note">
            此区域有启用的商品，请先转移或停用商品，才能停用区域。
          </p>
        )}
        <p className="fine-print">停用会保留已确认订单中的资料。</p>
        <ErrorText message={error ?? ""} />
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            返回
          </button>
          <button className="primary" disabled={busy}>
            <Check size={20} />
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ProductEditor({
  product,
  initialName,
  onSaved,
  onClose,
  ...props
}: ViewProps & {
  product?: Product;
  onClose: () => void;
  initialName?: string;
  onSaved?: (name: string) => void;
}) {
  const { data, mutate, busy, error } = props;
  const [name, setName] = useState(product?.name ?? initialName ?? "");
  const [englishName, setEnglishName] = useState(product?.english_name ?? "");
  const [aliases, setAliases] = useState(product?.aliases.join("\n") ?? "");
  const [zoneId, setZoneId] = useState(
    product?.zone_id ?? data.zones.find((z) => z.active)?.id ?? "",
  );
  const [active, setActive] = useState(product?.active ?? true);
  const [sortOrder, setSortOrder] = useState(
    product?.sort_order ?? data.products.length + 1,
  );
  const [units, setUnits] = useState<UnitRule[]>(
    product?.units ?? [{ orderUnit: "kg", billingUnit: "kg", price: null }],
  );
  function changeRule(index: number, patch: Partial<UnitRule>) {
    setUnits((current) => {
      const next = current.map((rule, i) =>
        i === index ? { ...rule, ...patch } : rule,
      );
      const selected = next[index];
      if ("price" in patch)
        return next.map((rule) =>
          rule.billingUnit === selected.billingUnit
            ? { ...rule, price: patch.price ?? null }
            : rule,
        );
      if ("billingUnit" in patch) {
        const other = current.find(
          (rule, i) => i !== index && rule.billingUnit === selected.billingUnit,
        );
        if (other) next[index] = { ...selected, price: other.price };
      }
      return next;
    });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (
      await mutate(
        {
          action: "saveProduct",
          ...(product ? { id: product.id, version: product.version } : {}),
          name,
          ...(englishName.trim() !== (product?.english_name ?? "")
            ? { englishName: englishName.trim() }
            : {}),
          aliases: splitAliases(aliases),
          zoneId,
          sortOrder,
          active,
          units,
        },
        "商品与标准价格已保存，现有订单保留原价",
      )
    ) {
      onSaved?.(name.trim());
      onClose();
    }
  }
  return (
    <Modal
      title={product ? "编辑商品与价格" : "添加商品"}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form onSubmit={save}>
        <Field label="商品名称">
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：日本 Timun"
          />
        </Field>
        <Field label="英文商品名（选填）" hint="用于英文单据，不会自动翻译。">
          <input
            maxLength={80}
            value={englishName}
            onChange={(e) => setEnglishName(e.target.value)}
            placeholder="例如：Japanese Cucumber"
          />
        </Field>
        <div className="two-columns">
          <Field label="所属区域">
            <select
              required
              value={zoneId}
              onChange={(e) => setZoneId(e.target.value)}
            >
              <option value="">请选择区域</option>
              {data.zones
                .filter((z) => z.active || z.id === zoneId)
                .map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                    {!z.active ? "（已停用）" : ""}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="区域内显示顺序" hint="数字较小的排在前面">
            <input
              type="number"
              inputMode="numeric"
              required
              min={0}
              max={9999}
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value))}
            />
          </Field>
        </div>
        <Field
          label="已确认别名（选填）"
          hint="每行一个，或用逗号分隔。相似但不同的商品请分别建立。"
        >
          <textarea
            rows={2}
            maxLength={4800}
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="例如：carrot，红萝卜"
          />
        </Field>
        <div className="section-heading">
          <h3>单位与标准售价</h3>
          <button
            type="button"
            className="text-button"
            disabled={units.length >= UNITS.length || busy}
            onClick={() => {
              const next = UNITS.find(
                (u) => !units.some((rule) => rule.orderUnit === u),
              );
              if (next)
                setUnits([
                  ...units,
                  {
                    orderUnit: next,
                    billingUnit: isWeight(next) ? "kg" : next,
                    price: isWeight(next)
                      ? (units.find((u) => u.billingUnit === "kg")?.price ??
                        null)
                      : null,
                  },
                ]);
            }}
          >
            <Plus size={19} />
            添加单位
          </button>
        </div>
        <p className="fine-print">
          公斤与克自动换算。包、箱等按独立售价计费；如需称重，明确选择「kg
          公斤」。
        </p>
        {units.map((rule, index) => (
          <div className="unit-rule" key={index}>
            <div className="unit-rule-fields">
              <Field label="订购单位">
                <select
                  value={rule.orderUnit}
                  onChange={(e) => {
                    const orderUnit = e.target.value as Unit;
                    const billingUnit = isWeight(orderUnit) ? "kg" : orderUnit;
                    const existing = units.find(
                      (u, i) => i !== index && u.billingUnit === billingUnit,
                    );
                    changeRule(index, {
                      orderUnit,
                      billingUnit,
                      price: existing?.price ?? null,
                    });
                  }}
                >
                  {UNITS.map((u) => (
                    <option
                      key={u}
                      value={u}
                      disabled={units.some(
                        (row, i) => i !== index && row.orderUnit === u,
                      )}
                    >
                      {UNIT_LABELS[u]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="计价单位">
                <select
                  value={rule.billingUnit}
                  onChange={(e) =>
                    changeRule(index, { billingUnit: e.target.value as Unit })
                  }
                >
                  {(isWeight(rule.orderUnit)
                    ? ["kg"]
                    : [rule.orderUnit, "kg"]
                  ).map((u) => (
                    <option key={u} value={u}>
                      {UNIT_LABELS[u as Unit]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`售价 RM / ${rule.billingUnit}`}>
                <input
                  inputMode="decimal"
                  placeholder="可留空待定"
                  value={rule.price ?? ""}
                  maxLength={10}
                  onChange={(e) =>
                    changeRule(index, { price: e.target.value || null })
                  }
                />
              </Field>
            </div>
            <button
              type="button"
              className="icon-button danger"
              aria-label={`移除${rule.orderUnit}单位`}
              disabled={units.length === 1 || busy}
              onClick={() => setUnits(units.filter((_, i) => i !== index))}
            >
              <Trash2 size={20} />
            </button>
          </div>
        ))}
        <Field label="商品状态">
          <select
            value={active ? "active" : "inactive"}
            onChange={(e) => setActive(e.target.value === "active")}
          >
            <option value="active">启用</option>
            <option value="inactive">停用（保留已有订单）</option>
          </select>
        </Field>
        <ErrorText message={error ?? ""} />
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            返回
          </button>
          <button className="primary" disabled={busy}>
            <Check size={20} />
            {busy ? "保存中…" : "保存商品"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function ShopSettings(
  props: ViewProps & {
    onLogout: () => Promise<void>;
    fontSize: FontSize;
    onFontSize: (value: FontSize) => void;
  },
) {
  const { data, mutate, busy } = props;
  const [section, setSection] = useState<
    "products" | "zones" | "restaurants" | "shop" | "prices" | "staff"
  >("products");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [filter, setFilter] = useState("");
  const [shopName, setShopName] = useState(data.shop.name);
  const [shopVersion, setShopVersion] = useState(data.shop.version);
  const [backupError, setBackupError] = useState("");
  const [exporting, setExporting] = useState(false);
  const settingsTabs = [
    {
      id: "products",
      label: "商品价格",
      icon: Package,
      count: data.products.length,
    },
    { id: "zones", label: "区域", icon: Layers, count: data.zones.length },
    {
      id: "restaurants",
      label: "餐馆",
      icon: Store,
      count: data.restaurants.length,
    },
    { id: "shop", label: "店铺", icon: Settings, count: undefined },
    { id: "prices", label: "餐馆专价", icon: Store, count: undefined },
    { id: "staff", label: "员工账号", icon: ShieldCheck, count: undefined },
  ] as const;
  async function downloadBackup() {
    setExporting(true);
    setBackupError("");
    try {
      const response = await startFileRequest("/api/backup", {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error("数据导出失败，请确认仍已登录，然后重试。");
      if (response.status === 202) {
        await downloadTicket(await waitCloudJob(await response.json()));
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `鲜配助手-数据导出-${data.date}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setBackupError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  const filteredProducts = data.products.filter((p) =>
    [p.name, ...p.aliases].some((n) =>
      n.toLowerCase().includes(filter.toLowerCase()),
    ),
  );
  const filteredRestaurants = data.restaurants.filter((r) =>
    [r.name, ...r.aliases].some((n) =>
      n.toLowerCase().includes(filter.toLowerCase()),
    ),
  );
  if (!allowed(data.user, "manage"))
    return (
      <>
        <h1>设置</h1>
        <FontSetting fontSize={props.fontSize} onFontSize={props.onFontSize} />
        <section className="panel">
          <h2>{data.user?.name}</h2>
          <p>员工账号 · 可配货及称重</p>
          <button className="secondary" onClick={() => void props.onLogout()}>
            退出账号
          </button>
        </section>
      </>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>店铺设置</h1>
          <p>维护常用商品、区域、餐馆与标准价格</p>
        </div>
        <div className="page-marker">
          <ShieldCheck size={22} />
          店主
        </div>
      </div>
      <FontSetting fontSize={props.fontSize} onFontSize={props.onFontSize} />
      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        {settingsTabs.map(({ id, label, icon: Icon, count }) => (
          <button
            role="tab"
            aria-selected={section === id}
            className={section === id ? "selected" : ""}
            key={id}
            onClick={() => {
              setSection(id);
              setFilter("");
            }}
          >
            <Icon size={21} />
            <span>{label}</span>
            {count !== undefined && <small>{count}</small>}
          </button>
        ))}
      </div>
      {section === "staff" ? (
        <StaffSettings {...props} />
      ) : section === "prices" ? (
        <RestaurantPrices {...props} />
      ) : section === "products" ? (
        <>
          <div className="list-toolbar">
            <input
              type="search"
              aria-label="搜索商品"
              placeholder="搜索商品名或别名"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button
              className="primary"
              disabled={busy || !data.zones.some((z) => z.active)}
              onClick={() => setEditor({ kind: "product" })}
            >
              <Plus size={22} />
              添加商品
            </button>
          </div>
          {!data.zones.some((z) => z.active) && (
            <div className="inline-note">
              请先在「区域」中添加至少一个区域。
            </div>
          )}
          {data.products.length === 0 ? (
            <Empty
              title="把常卖的商品加进来"
              action={
                <button
                  className="secondary"
                  onClick={() =>
                    data.zones.some((z) => z.active)
                      ? setEditor({ kind: "product" })
                      : setSection("zones")
                  }
                >
                  {data.zones.some((z) => z.active) ? "添加商品" : "先添加区域"}
                </button>
              }
            >
              设置商品名称、订购单位和售价，录单时就能直接选择。
            </Empty>
          ) : (
            <div className="catalog-list">
              {filteredProducts.map((product) => (
                <article
                  className={`catalog-row ${!product.active ? "inactive" : ""}`}
                  key={product.id}
                >
                  <div className="catalog-icon">
                    <Package size={23} />
                  </div>
                  <div className="catalog-content">
                    <h3>
                      {product.name}
                      {!product.active && <span className="tag">已停用</span>}
                    </h3>
                    <p>
                      {data.zones.find((z) => z.id === product.zone_id)?.name}
                      {product.aliases.length > 0
                        ? ` · ${product.aliases.join(" / ")}`
                        : ""}
                    </p>
                    <div className="unit-prices">
                      {[
                        ...new Map(
                          product.units.map((u) => [u.billingUnit, u]),
                        ).values(),
                      ].map((u) => (
                        <span key={u.billingUnit}>
                          {money(u.price)} / {u.billingUnit}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    className="secondary compact"
                    onClick={() =>
                      setEditor({ kind: "product", value: product })
                    }
                  >
                    <Pencil size={18} />
                    <span>编辑</span>
                  </button>
                </article>
              ))}
              {filteredProducts.length === 0 && (
                <p className="muted">没有匹配的商品。</p>
              )}
            </div>
          )}
          <p className="stage-note">
            价格变动只影响新确认的订单。已有订单需在称重页明确选择「读取现价」。
          </p>
        </>
      ) : section === "zones" ? (
        <>
          <div className="list-toolbar">
            <h2>按店内拿货顺序排列</h2>
            <button
              className="primary"
              onClick={() => setEditor({ kind: "zone" })}
            >
              <Plus size={22} />
              添加区域
            </button>
          </div>
          {data.zones.length === 0 ? (
            <Empty
              title="先划分店内区域"
              action={
                <button
                  className="primary"
                  onClick={() => setEditor({ kind: "zone" })}
                >
                  <Plus size={22} />
                  添加第一个区域
                </button>
              }
            >
              例如：萝卜 / Timun 区、豆腐区、包菜区。
            </Empty>
          ) : (
            <div className="catalog-list">
              {data.zones.map((zone, index) => (
                <article
                  className={`catalog-row zone-catalog ${!zone.active ? "inactive" : ""}`}
                  key={zone.id}
                >
                  <span className="zone-position">{index + 1}</span>
                  <div className="catalog-content">
                    <h3>
                      {zone.name}
                      {!zone.active && <span className="tag">已停用</span>}
                    </h3>
                    <p>
                      {
                        data.products.filter(
                          (p) => p.zone_id === zone.id && p.active,
                        ).length
                      }{" "}
                      种启用商品
                    </p>
                  </div>
                  <div className="zone-controls">
                    <button
                      className="icon-button"
                      aria-label={`${zone.name}上移`}
                      disabled={index === 0 || busy}
                      onClick={() =>
                        void mutate(
                          {
                            action: "moveZone",
                            id: zone.id,
                            version: zone.version,
                            direction: "up",
                          },
                          "区域顺序已保存",
                        )
                      }
                    >
                      <ArrowUp size={20} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`${zone.name}下移`}
                      disabled={index === data.zones.length - 1 || busy}
                      onClick={() =>
                        void mutate(
                          {
                            action: "moveZone",
                            id: zone.id,
                            version: zone.version,
                            direction: "down",
                          },
                          "区域顺序已保存",
                        )
                      }
                    >
                      <ArrowDown size={20} />
                    </button>
                    <button
                      className="secondary compact"
                      onClick={() => setEditor({ kind: "zone", value: zone })}
                    >
                      <Pencil size={18} />
                      编辑
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          <p className="stage-note">
            用上移 / 下移安排显示顺序。商品所属区域在「商品价格」中设置。
          </p>
        </>
      ) : section === "restaurants" ? (
        <>
          <div className="list-toolbar">
            <input
              type="search"
              aria-label="搜索餐馆"
              placeholder="搜索餐馆或别名"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button
              className="primary"
              onClick={() => setEditor({ kind: "restaurant" })}
            >
              <Plus size={22} />
              添加餐馆
            </button>
          </div>
          {data.restaurants.length === 0 ? (
            <Empty
              title="添加常来订货的餐馆"
              action={
                <button
                  className="primary"
                  onClick={() => setEditor({ kind: "restaurant" })}
                >
                  <Plus size={22} />
                  添加餐馆
                </button>
              }
            >
              保存一次，以后每天从列表选择，不用重复填写。
            </Empty>
          ) : (
            <div className="catalog-list">
              {filteredRestaurants.map((restaurant) => (
                <article
                  className={`catalog-row ${!restaurant.active ? "inactive" : ""}`}
                  key={restaurant.id}
                >
                  <div className="catalog-icon">
                    <Store size={23} />
                  </div>
                  <div className="catalog-content">
                    <h3>
                      {restaurant.name}
                      {!restaurant.active && (
                        <span className="tag">已停用</span>
                      )}
                    </h3>
                    <p>{restaurant.aliases.join(" / ") || "暂无别名"}</p>
                  </div>
                  <button
                    className="secondary compact"
                    onClick={() =>
                      setEditor({ kind: "restaurant", value: restaurant })
                    }
                  >
                    <Pencil size={18} />
                    编辑
                  </button>
                </article>
              ))}
              {filteredRestaurants.length === 0 && (
                <p className="muted">没有匹配的餐馆。</p>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="shop-settings">
          <section className="panel">
            <div className="section-heading">
              <h2>店铺资料</h2>
              <Store size={24} />
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await mutate(
                    {
                      action: "saveShop",
                      name: shopName,
                      version: shopVersion,
                    },
                    "店名已保存",
                  )
                )
                  setShopVersion((v) => v + 1);
              }}
            >
              <Field label="店名">
                <input
                  required
                  maxLength={80}
                  value={shopName}
                  onChange={(e) => setShopName(e.target.value)}
                />
              </Field>
              <button className="primary" disabled={busy}>
                <Check size={20} />
                保存店名
              </button>
            </form>
            <div className="setting-detail">
              <span>时区</span>
              <strong>马来西亚 · UTC+8</strong>
            </div>
            <div className="setting-detail">
              <span>货币</span>
              <strong>RM · 马来西亚令吉</strong>
            </div>
            <div className="setting-detail">
              <span>访问方式</span>
              <strong>独立员工账号 · 共享店铺</strong>
            </div>
            <button
              className="text-button"
              onClick={() => void props.onLogout()}
              disabled={busy}
            >
              <LogOut size={18} />
              退出店主账号
            </button>
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>保存与数据导出</h2>
              <Download size={24} />
            </div>
            <p>已保存的订单在服务端数据库中，刷新网页或重启服务不会清除。</p>
            <p>
              导出店铺设置、全部日期订单和操作记录。文件不含密码、登录凭证或 API
              密钥。
            </p>
            <button
              className="secondary"
              disabled={exporting || busy}
              onClick={() => void downloadBackup()}
            >
              <Download size={20} />
              {exporting ? "正在导出…" : "导出全部数据"}
            </button>
            <ErrorText message={backupError} />
            <BackupRestore />
          </section>
          <ThresholdSettings {...props} />
        </div>
      )}
      {editor && editor.kind === "product" ? (
        <ProductEditor
          {...props}
          product={editor.value}
          onClose={() => setEditor(null)}
        />
      ) : editor ? (
        <BasicEditor
          {...props}
          editor={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </>
  );
}

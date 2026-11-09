import { AppError } from "./errors";
export function cloudMode() {
  const backend = process.env.SHOP_BACKEND || "local";
  if (!["local", "supabase"].includes(backend))
    throw new AppError("SHOP_BACKEND 配置无效", 503);
  if (process.env.NETLIFY === "true" && backend !== "supabase")
    throw new AppError("Netlify 必须使用云端持久存储，不能使用本机数据库", 503);
  return backend === "supabase";
}
export function cloudConfig() {
  if (process.env.SHOP_CLOUD_FREE_TIER_CONFIRMED !== "true")
    throw new AppError(
      "云端尚未确认使用免费方案，请由店主先核对 Free 计划",
      503,
    );
  const required = [
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_JWT_SECRET",
    "SHOP_PUBLIC_ORIGIN",
  ] as const;
  for (const key of required)
    if (!process.env[key]) throw new AppError(`云端缺少 ${key} 配置`, 503);
  const url = new URL(process.env.SUPABASE_URL!);
  const origin = new URL(process.env.SHOP_PUBLIC_ORIGIN!);
  const database = new URL(process.env.DATABASE_URL!);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".supabase.co") ||
    origin.protocol !== "https:" ||
    origin.origin !== process.env.SHOP_PUBLIC_ORIGIN ||
    !["postgres:", "postgresql:"].includes(database.protocol)
  )
    throw new AppError("云端网址、HTTPS 或数据库配置无效", 503);
  return {
    databaseUrl: database.toString(),
    url: url.origin,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    jwtSecret: process.env.SUPABASE_JWT_SECRET!,
    origin: origin.origin,
    bucket: process.env.SUPABASE_STORAGE_BUCKET || "shop-private",
  };
}

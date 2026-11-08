import type { Unit } from "./domain";
export const PRIVACY_VERSION = "gemini-unpaid-2026-11-v1";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 20000;
export type ReviewLine = {
  id: string;
  sourceLine: number;
  sourceText: string;
  productText: string;
  productId: string;
  quantity: string;
  unit: Unit | "";
  matchedBy:
    "name" | "alias" | "ambiguous" | "suggested" | "unknown" | "manual";
  candidates: string[];
  extractionIssues: string[];
  disposition: "item" | "ignored";
  ignoreReason: string;
  reviewed: boolean;
  saveAlias: boolean;
};
export type ImportDraft = {
  id: string;
  restaurant_id: string;
  restaurant_name: string;
  delivery_date: string;
  source_kind: "text" | "image";
  original_text: string;
  source_hash: string;
  status: "draft" | "review" | "extracting" | "failed" | "confirmed";
  lines: ReviewLine[];
  detected_restaurant: string | null;
  restaurant_acknowledged: boolean;
  source_checked: boolean;
  error_message: string | null;
  extraction_warning: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  confirmed_order_id: string | null;
  original_mime: string | null;
  prepared_mime: string | null;
  attempts: number;
};
export type DraftSummary = Pick<
  ImportDraft,
  | "id"
  | "restaurant_name"
  | "delivery_date"
  | "source_kind"
  | "status"
  | "updated_at"
>;
export type ImportConfig = {
  enabled: boolean;
  model: string;
  reason: string;
  maxRpm: number;
  maxRpd: number;
};
export type ConfirmationMode = "new" | "replace" | "append";
export type PlannedLine = {
  productId: string;
  name: string;
  quantity: string;
  unit: Unit;
  billingUnit: Unit;
  price: string | null;
  existingItemId: string | null;
  sourceLineIds: string[];
  changesQuantity: boolean;
  resetsActual: boolean;
};
export type ImportPreview = {
  token: string;
  mode: ConfirmationMode;
  orderId: string | null;
  orderVersion: number | null;
  restaurantName: string;
  date: string;
  lines: PlannedLine[];
  mergedRows: number;
  missingPrices: number;
  identicalSource: boolean;
};
export const normalizeName = (value: string) =>
  value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/g, " ");

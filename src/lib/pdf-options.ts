import { z } from "zod";

export const pdfLanguageSchema = z.enum(["zh", "en"]);
export const pdfSummarySchema = z.enum(["first", "last", "none"]);
export type PdfLanguage = z.infer<typeof pdfLanguageSchema>;
export type PdfSummary = z.infer<typeof pdfSummarySchema>;
export type PdfOptions = {
  language?: PdfLanguage;
  summary?: PdfSummary;
  from?: string;
  to?: string;
};

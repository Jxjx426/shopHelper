import type { Config } from "@netlify/functions";
import { processCloudJob } from "../../src/lib/cloud-jobs.server";
export default async (request: Request) => {
  try {
    const text = await request.text();
    if (text.length > 2048) return;
    const input = JSON.parse(text);
    if (
      typeof input.id !== "string" ||
      typeof input.secret !== "string" ||
      input.secret.length !== 64
    )
      return;
    await processCloudJob(input.id, input.secret);
  } catch {
    /* Task state records failures; do not ask Netlify to retry writes. */
  }
};
export const config: Config = { background: true };

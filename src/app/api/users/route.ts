import { NextRequest } from "next/server";
import { failure, json, requireUser } from "@/lib/http";
import { listStaff } from "@/lib/users.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    return json({ users: await listStaff((await requireUser(request)).id) });
  } catch (error) {
    return failure(error);
  }
}

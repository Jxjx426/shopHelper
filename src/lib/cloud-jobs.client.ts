"use client";
export async function waitCloudJob(job: { jobId: string; receipt?: string }) {
  const deadline = Date.now() + 16 * 60 * 1000;
  let delay = 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const r = await fetch(`/api/jobs/${job.jobId}`, {
      cache: "no-store",
      headers: job.receipt ? { "X-Job-Receipt": job.receipt } : {},
      signal: AbortSignal.timeout(15000),
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error);
    if (value.status === "succeeded") return value.result;
    if (value.status === "failed")
      throw new Error(value.error || "后台处理失败，请核对后重试");
    delay = Math.min(delay * 1.5, 5000);
  }
  throw new Error("后台任务等待超时，请重新登录并检查结果；没有自动重复提交");
}

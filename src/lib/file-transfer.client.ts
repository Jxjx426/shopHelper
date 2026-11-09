"use client";
export async function uploadPrivateFile(file: Blob, kind: "image" | "backup") {
  const r = await fetch("/api/files/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind,
      mime: file.type || "application/json",
      size: file.size,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const upload = await r.json();
  if (!r.ok) throw new Error(upload.error);
  if (!upload.direct) return null;
  let offset = 0;
  for (const part of upload.parts) {
    const response = await fetch(part.url, {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/json",
        apikey: upload.publishableKey,
      },
      body: file.slice(offset, offset + part.size),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error("文件上传失败，原输入仍保留，请重试");
    offset += part.size;
  }
  return upload.id as string;
}
export async function downloadTicket(ticket: {
  filename: string;
  mime: string;
  parts: { url: string; size: number }[];
}) {
  if (ticket.parts.length === 1) {
    const a = document.createElement("a");
    a.href = ticket.parts[0].url;
    a.download = ticket.filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const chunks: Blob[] = [];
  for (const part of ticket.parts) {
    const r = await fetch(part.url, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error("备份下载未完成，请重试");
    const blob = await r.blob();
    if (blob.size !== part.size) throw new Error("备份分段不完整，请重试");
    chunks.push(blob);
  }
  const url = URL.createObjectURL(new Blob(chunks, { type: ticket.mime })),
    a = document.createElement("a");
  a.href = url;
  a.download = ticket.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

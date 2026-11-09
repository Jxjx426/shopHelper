"use client";
import { useEffect, useRef, useState } from "react";
import { Crop, Shield, RotateCcw } from "lucide-react";
import { MAX_IMAGE_BYTES } from "@/lib/import-types";
import { preparedImageSize } from "@/lib/image-limits";
import { ErrorText } from "./ui";
export type ImagePayload = {
  mime: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
};
export type ScreenshotPayload = {
  original: ImagePayload;
  prepared: ImagePayload;
};
type Rect = { x: number; y: number; width: number; height: number };
export default function ScreenshotEditor({
  onChange,
  disabled,
}: {
  onChange: (value: ScreenshotPayload | null) => void;
  disabled: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const original = useRef<ImagePayload | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [masks, setMasks] = useState<Rect[]>([]);
  const [mode, setMode] = useState<"crop" | "mask">("crop");
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const [previewRect, setPreviewRect] = useState<Rect | null>(null);
  const [imageVersion, setImageVersion] = useState(0);
  const [working, setWorking] = useState(false);
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    const source = image.current,
      target = canvas.current;
    if (!source || !target) return;
    const scale = Math.min(
      1,
      800 / source.naturalWidth,
      1600 / source.naturalHeight,
    );
    target.width = Math.round(source.naturalWidth * scale);
    target.height = Math.round(source.naturalHeight * scale);
    const ctx = target.getContext("2d")!;
    ctx.drawImage(source, 0, 0, target.width, target.height);
    ctx.fillStyle = "#000";
    for (const mask of masks)
      ctx.fillRect(
        mask.x * scale,
        mask.y * scale,
        mask.width * scale,
        mask.height * scale,
      );
    const selection = previewRect ?? crop;
    if (selection) {
      ctx.strokeStyle = mode === "mask" && previewRect ? "#a5352d" : "#2b7e4a";
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 4]);
      ctx.strokeRect(
        selection.x * scale,
        selection.y * scale,
        selection.width * scale,
        selection.height * scale,
      );
    }
  }, [crop, masks, previewRect, mode, imageVersion]);
  useEffect(() => {
    const source = image.current;
    if (!source || !original.current) return;
    try {
      const selection = crop ?? {
        x: 0,
        y: 0,
        width: source.naturalWidth,
        height: source.naturalHeight,
      };
      const output = document.createElement("canvas");
      const size = preparedImageSize(selection.width, selection.height);
      output.width = size.width;
      output.height = size.height;
      const ctx = output.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, output.width, output.height);
      ctx.drawImage(
        source,
        selection.x,
        selection.y,
        selection.width,
        selection.height,
        0,
        0,
        output.width,
        output.height,
      );
      ctx.fillStyle = "#000";
      for (const mask of masks)
        ctx.fillRect(
          ((mask.x - selection.x) * output.width) / selection.width,
          ((mask.y - selection.y) * output.height) / selection.height,
          (mask.width * output.width) / selection.width,
          (mask.height * output.height) / selection.height,
        );
      const base64 = output.toDataURL("image/jpeg", 0.94).split(",")[1];
      if (base64.length * 0.75 > MAX_IMAGE_BYTES) {
        setError("处理后的图片超过5MB，请裁剪成较小截图");
        callback.current(null);
        return;
      }
      callback.current({
        original: original.current,
        prepared: { mime: "image/jpeg", base64 },
      });
      setError("");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "图片处理失败，请换一张较小截图",
      );
      callback.current(null);
    }
  }, [crop, masks, imageVersion]);
  async function selectFile(file: File | undefined) {
    if (!file) return;
    callback.current(null);
    setError("");
    image.current = null;
    original.current = null;
    setFilename("");
    setCrop(null);
    setMasks([]);
    setPreviewRect(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("请选择 PNG、JPG 或 WebP 手机截图，不支持 HEIC/SVG");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("截图不能超过5MB，请先在手机相册中裁剪或分成较小截图");
      return;
    }
    setWorking(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const loaded = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = data;
      });
      if (
        loaded.naturalWidth * loaded.naturalHeight > 24000000 ||
        loaded.naturalHeight > 20000 ||
        loaded.naturalWidth > 20000
      )
        throw new Error("截图过长或尺寸太大，请先在相册分成较小截图");
      image.current = loaded;
      original.current = {
        mime: file.type as ImagePayload["mime"],
        base64: data.split(",")[1],
      };
      setFilename(file.name);
      setCrop(null);
      setMasks([]);
      setPreviewRect(null);
      setImageVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "图片无法读取，请重新选择截图");
    } finally {
      setWorking(false);
    }
  }
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          image.current!.naturalWidth,
          ((event.clientX - rect.left) / rect.width) *
            image.current!.naturalWidth,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          image.current!.naturalHeight,
          ((event.clientY - rect.top) / rect.height) *
            image.current!.naturalHeight,
        ),
      ),
    };
  }
  function rectBetween(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): Rect {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }
  return (
    <div className="screenshot-editor">
      <label className="upload-control">
        <span>
          {working
            ? "正在读取图片…"
            : filename
              ? "更换截图"
              : "从手机相册选择截图"}
        </span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="选择订单截图"
          disabled={disabled || working}
          onChange={(e) => void selectFile(e.target.files?.[0])}
        />
      </label>
      {filename && (
        <>
          <p className="fine-print">
            {filename} ·
            拖动框选保留区域，或遮盖电话、联系人和无关聊天。处理在本机浏览器完成。
          </p>
          <div className="image-tools">
            <button
              type="button"
              className={mode === "crop" ? "primary" : "secondary"}
              onClick={() => setMode("crop")}
              disabled={disabled}
            >
              <Crop size={18} />
              裁剪
            </button>
            <button
              type="button"
              className={mode === "mask" ? "primary" : "secondary"}
              onClick={() => setMode("mask")}
              disabled={disabled}
            >
              <Shield size={18} />
              遮盖
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setCrop(null);
                setMasks([]);
              }}
              disabled={disabled}
            >
              <RotateCcw size={18} />
              重置
            </button>
          </div>
          <div className="canvas-frame">
            <canvas
              ref={canvas}
              aria-label="订单截图裁剪遮盖预览"
              onPointerDown={(e) => {
                if (disabled || !image.current) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = point(e);
              }}
              onPointerMove={(e) => {
                if (drag.current)
                  setPreviewRect(rectBetween(drag.current, point(e)));
              }}
              onPointerCancel={() => {
                drag.current = null;
                setPreviewRect(null);
              }}
              onPointerUp={(e) => {
                if (!drag.current) return;
                const rect = rectBetween(drag.current, point(e));
                drag.current = null;
                setPreviewRect(null);
                if (rect.width < 12 || rect.height < 12) return;
                if (mode === "crop") setCrop(rect);
                else setMasks((current) => [...current, rect]);
              }}
            />
          </div>
          <p className="inline-note">
            {crop ? "已选择裁剪区域" : "使用整张截图"} · 已遮盖 {masks.length}{" "}
            处。保存时上传至店铺私有存储（云端版为
            Supabase）。只有处理图会在确认后发给 Gemini。
          </p>
        </>
      )}
      <ErrorText message={error} />
    </div>
  );
}

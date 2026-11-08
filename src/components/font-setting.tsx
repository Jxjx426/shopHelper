"use client";
import { useEffect, useState } from "react";
export type FontSize = "standard" | "large" | "extra-large";
const key = "fresh-helper-font-size";
export function useFontSize() {
  const [fontSize, setFontSize] = useState<FontSize>("large");
  useEffect(() => {
    try {
      const value = localStorage.getItem(key);
      if (value === "standard" || value === "large" || value === "extra-large")
        setFontSize(value);
    } catch {
      /* This device can still use the default when storage is disabled. */
    }
  }, []);
  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize;
  }, [fontSize]);
  function change(value: FontSize) {
    setFontSize(value);
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Session-only preference. */
    }
  }
  return { fontSize, onFontSize: change };
}
export function FontSetting({
  fontSize,
  onFontSize,
}: {
  fontSize: FontSize;
  onFontSize: (value: FontSize) => void;
}) {
  return (
    <div className="font-setting" role="group" aria-label="显示字号">
      <strong>字号</strong>
      <div>
        {(
          [
            ["standard", "标准"],
            ["large", "大字"],
            ["extra-large", "特大"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={fontSize === value ? "primary" : "secondary"}
            aria-pressed={fontSize === value}
            onClick={() => onFontSize(value)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

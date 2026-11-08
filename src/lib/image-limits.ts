/** Keep long screenshots wide enough to read; ask for splitting instead of tiny text. */
export function preparedImageSize(width: number, height: number) {
  const scale = Math.min(
    1,
    1600 / width,
    12000 / height,
    Math.sqrt(12000000 / (width * height)),
  );
  if (width * scale < Math.min(width, 900))
    throw new Error("截图太长，缩小后文字难以辨认，请裁剪或分成多张截图");
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

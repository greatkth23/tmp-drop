// Bound automatic preview traffic; full downloads keep their existing limits.
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
export function canPreviewImage(filename: string, size: number) {
  return (
    size > 0 && size <= IMAGE_PREVIEW_MAX_BYTES && /\.(png|jpe?g|gif|webp|avif)$/i.test(filename)
  );
}

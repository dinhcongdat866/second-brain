/**
 * Client-side image downscale before sending to the vision API.
 *
 * Claude resizes images to ~1.15 MP / 1568px long edge anyway, so we cap there
 * to avoid uploading needlessly large payloads (also keeps the base64 we store
 * in the Y.Doc reasonable). Everything is re-encoded as JPEG.
 */

const MAX_EDGE = 1568;
const QUALITY = 0.82;

/** Resize an image file to a JPEG data URL with its long edge ≤ MAX_EDGE. */
export async function resizeImageToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Canvas 2D context unavailable');
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', QUALITY);
}

export interface ApiImage {
  media_type: string;
  data: string;
}

/** Split a `data:<type>;base64,<data>` URL into the parts the API expects. */
export function dataUrlToApiImage(dataUrl: string): ApiImage | null {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  return { media_type: m[1], data: m[2] };
}

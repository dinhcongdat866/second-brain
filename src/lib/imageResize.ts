/**
 * Client-side image downscale before sending to the vision API.
 *
 * Claude resizes images to ~1.15 MP / 1568px long edge anyway, so we cap there
 * to avoid uploading needlessly large payloads (also keeps the base64 we store
 * in the Y.Doc reasonable). Everything is re-encoded as JPEG.
 */

const MAX_EDGE = 1568;
const QUALITY = 0.82;

/** Draw a downscaled copy of `file` onto a canvas (long edge ≤ maxEdge). */
async function drawDownscaled(file: File, maxEdge: number): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
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
  return canvas;
}

/** Resize an image file to a JPEG data URL with its long edge ≤ MAX_EDGE. */
export async function resizeImageToDataUrl(file: File): Promise<string> {
  const canvas = await drawDownscaled(file, MAX_EDGE);
  return canvas.toDataURL('image/jpeg', QUALITY);
}

/** Resize an image file to a JPEG Blob (for upload). Larger default edge for
 *  document images that are viewed full-size, not just understood by the model. */
export async function resizeImageToBlob(file: File, maxEdge = 1920, quality = 0.85): Promise<Blob> {
  const canvas = await drawDownscaled(file, maxEdge);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/jpeg',
      quality,
    ),
  );
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

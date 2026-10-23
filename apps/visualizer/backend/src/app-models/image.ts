/**
 * The image as the model was trained on it, prepared exactly as the converter's reference so an answer
 * here matches the model's own.
 *
 * `Image.thumbnail((512, 512))` (bicubic), then the Idefics3 processor without splitting: longest edge to
 * 2048 (lanczos), squashed to 512×512 (lanczos), rescaled and normalised with mean = std = 0.5.
 */
import { pilResize, type Plane } from '../imaging/pil-resample.js';

const THUMBNAIL = 512;
const PROCESSOR_LONGEST_EDGE = 2048;
export const IMAGE_TILE = 512;
export const PIXEL_VALUES_SHAPE = [1, 3, IMAGE_TILE, IMAGE_TILE] as const;

/** PIL `Image.thumbnail` target size, or null when the image already fits. */
export function thumbnailSize(w: number, h: number, max: number): [number, number] | null {
  if (max >= w && max >= h) return null;
  const aspect = w / h;
  const roundAspect = (n: number, key: (v: number) => number) => {
    const a = Math.floor(n);
    const b = Math.ceil(n);
    return Math.max(key(b) < key(a) ? b : a, 1);
  };
  let x = max;
  let y = max;
  if (x / y >= aspect) x = roundAspect(y * aspect, (n) => Math.abs(aspect - n / y));
  else y = roundAspect(x / aspect, (n) => (n === 0 ? 0 : Math.abs(aspect - x / n)));
  return [x, y];
}

/** Idefics3 `_resize_output_size_rescale_to_max_len`: longest edge to `maxLen`, short edge rounded up to even. */
export function rescaleToMaxLen(w: number, h: number, maxLen: number): [number, number] {
  const aspect = w / h;
  if (w >= h) {
    let nh = Math.trunc(maxLen / aspect);
    if (nh % 2 !== 0) nh += 1;
    return [maxLen, Math.max(nh, 1)];
  }
  let nw = Math.trunc(maxLen * aspect);
  if (nw % 2 !== 0) nw += 1;
  return [Math.max(nw, 1), maxLen];
}

/** Planar RGB `[3, 512, 512]` in [-1, 1]. */
export function imagePixelValues(rgb: Plane): Float32Array {
  let img = rgb;
  const th = thumbnailSize(img.width, img.height, THUMBNAIL);
  if (th) img = pilResize(img, th[0], th[1], 'bicubic');
  const [w2, h2] = rescaleToMaxLen(img.width, img.height, PROCESSOR_LONGEST_EDGE);
  img = pilResize(img, w2, h2, 'lanczos');
  img = pilResize(img, IMAGE_TILE, IMAGE_TILE, 'lanczos');
  const plane = IMAGE_TILE * IMAGE_TILE;
  const out = new Float32Array(3 * plane);
  const { data, channels } = img;
  for (let ch = 0; ch < 3; ch++) {
    const base = ch * plane;
    for (let i = 0; i < plane; i++) out[base + i] = (data[i * channels + ch]! * (1 / 255) - 0.5) / 0.5;
  }
  return out;
}

/**
 * Frame substance detector — preview statistics and verdict rules.
 *
 * Decoding uses sharp; greyscale uses `pilGreyscale` because `sharp().greyscale()`
 * disagrees with ITU-R 601-2 luma on a quarter of pixels. See `pil-resample.ts`.
 */
import { createHash } from 'node:crypto';
import { decodePlaneFromFile } from './decode-plane.js';
import { pilGreyscale, type Plane } from './pil-resample.js';

/** Trigger thresholds — inherited from the prototype's FFmpeg `blackdetect` rules. */
export const BLACK_PIXEL_TH = 25;
export const BLACK_AREA_TH = 0.98;
export const BLOWN_PIXEL_TH = 235;
export const BLOWN_AREA_TH = 0.98;

/** Verdict thresholds — measured on the catalog, not inherited. */
export const VOID_LAP_VAR = 0.1;
export const VOID_TILE_MAX = 1.6;
export const ILLEGIBLE_ENTROPY = 1.05;
export const ILLEGIBLE_TILE_MAX = 20.0;
export const ILLEGIBLE_LAP_VAR = 20.0;

export type Verdict = 'void' | 'illegible' | 'ok' | 'unknown';

export type UnknownReason =
  | 'no_cache_row'
  | 'oversized_sentinel'
  | 'cache_file_missing'
  | 'decode_failed'
  | '';

export interface FrameStatistics {
  black_frac_25: number;
  blown_frac_235: number;
  entropy: number;
  lap_var: number;
  tile_max: number;
}

const THRESHOLD_TUPLE = [
  BLACK_AREA_TH,
  BLOWN_AREA_TH,
  VOID_LAP_VAR,
  VOID_TILE_MAX,
  ILLEGIBLE_ENTROPY,
  ILLEGIBLE_TILE_MAX,
  ILLEGIBLE_LAP_VAR,
] as const;

/**
 * Format a float for the detector version hash — always includes a decimal point.
 *
 * `String(20.0)` is `"20"`; the version hash is over exactly this text.
 */
function pythonFloatStr(value: number): string {
  const s = String(value);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

/** Stable version string derived from the active threshold tuple. */
export function detectorVersion(): string {
  const payload = THRESHOLD_TUPLE.map(pythonFloatStr).join(',');
  return `v1-${createHash('sha256').update(payload).digest('hex').slice(0, 8)}`;
}

/** The five rule-input statistics of an 8-bit greyscale plane. */
export function computeStatisticsFromGreyscale(grey: Plane): FrameStatistics {
  const { width, height, data } = grey;
  const total = width * height;
  if (total === 0) {
    return { black_frac_25: 0, blown_frac_235: 0, entropy: 0, lap_var: 0, tile_max: 0 };
  }

  const hist = new Float64Array(256);
  for (let i = 0; i < total; i++) hist[data[i]!]! += 1;

  let atOrBelowBlack = 0;
  for (let v = 0; v <= BLACK_PIXEL_TH; v++) atOrBelowBlack += hist[v]!;
  let atOrAboveBlown = 0;
  for (let v = BLOWN_PIXEL_TH; v < 256; v++) atOrAboveBlown += hist[v]!;

  let entropy = 0;
  for (let v = 0; v < 256; v++) {
    const p = hist[v]! / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  return {
    black_frac_25: atOrBelowBlack / total,
    blown_frac_235: atOrAboveBlown / total,
    entropy,
    lap_var: laplacianVariance(grey),
    tile_max: tileMax(grey),
  };
}

/**
 * Variance of the 4-neighbour Laplacian over the interior pixels.
 *
 * Accumulated in float64; fixture tests compare with a relative tolerance.
 */
function laplacianVariance(grey: Plane): number {
  const { width, height, data } = grey;
  const w = width - 2;
  const h = height - 2;
  if (w <= 0 || h <= 0) return 0;

  const n = w * h;
  const lap = new Float64Array(n);
  let sum = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const v =
        -4 * data[row + x]! +
        data[row - width + x]! +
        data[row + width + x]! +
        data[row + x - 1]! +
        data[row + x + 1]!;
      lap[(y - 1) * w + (x - 1)] = v;
      sum += v;
    }
  }

  const mean = sum / n;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = lap[i]! - mean;
    acc += d * d;
  }
  return acc / n;
}

/**
 * Brightest cell of a 32×32 grid of tile means — the statistic that separates a
 * frame with a small bright subject from one that is uniformly dark.
 *
 * Cell size is `floor(dimension / 32)`, and the remainder is cropped away, so a
 * frame under 32 pixels on a side has no grid and throws. `computeStatisticsFromPath`
 * turns the throw into an `unknown` verdict for that one image.
 */
function tileMax(grey: Plane): number {
  const { width, height, data } = grey;
  const ty = Math.max(Math.trunc(height / 32), 1);
  const tx = Math.max(Math.trunc(width / 32), 1);
  if (ty * 32 > height || tx * 32 > width) {
    throw new Error(`frame substance: ${width}x${height} is too small to tile into 32x32`);
  }

  const cellPixels = ty * tx;
  let max = -Infinity;
  for (let i = 0; i < 32; i++) {
    for (let j = 0; j < 32; j++) {
      let sum = 0;
      for (let a = 0; a < ty; a++) {
        const row = (i * ty + a) * width + j * tx;
        for (let b = 0; b < tx; b++) sum += data[row + b]!;
      }
      const mean = sum / cellPixels;
      if (mean > max) max = mean;
    }
  }
  return max;
}

/**
 * Decode a cached preview and return its statistics, or `null` when it cannot be
 * measured — a corrupt file in a large cache is one `unknown` verdict, not an
 * aborted run.
 */
export async function computeStatisticsFromPath(path: string): Promise<FrameStatistics | null> {
  try {
    const plane = await decodePlaneFromFile(path, { limitInputPixels: false });
    return computeStatisticsFromGreyscale(pilGreyscale(plane));
  } catch {
    return null;
  }
}

/** `void` | `illegible` | `ok` from the five rule-input statistics. */
export function classifyVerdict(stats: FrameStatistics): Exclude<Verdict, 'unknown'> {
  const triggeredDark = stats.black_frac_25 >= BLACK_AREA_TH;
  const triggeredBlown = stats.blown_frac_235 >= BLOWN_AREA_TH;
  if (!triggeredDark && !triggeredBlown) return 'ok';
  if (stats.lap_var < VOID_LAP_VAR || stats.tile_max <= VOID_TILE_MAX) return 'void';
  if (triggeredBlown) return stats.entropy < ILLEGIBLE_ENTROPY ? 'illegible' : 'ok';
  if (
    stats.entropy < ILLEGIBLE_ENTROPY &&
    stats.tile_max < ILLEGIBLE_TILE_MAX &&
    stats.lap_var < ILLEGIBLE_LAP_VAR
  ) {
    return 'illegible';
  }
  return 'ok';
}

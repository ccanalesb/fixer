/**
 * Lightroom orientation codes, and turning a decoded image upright by them.
 *
 * `Adobe_images.orientation` names where the stored image's top-left and
 * top-right corners land on screen (A top-left, B top-right, C bottom-right,
 * D bottom-left): `AB` is as stored, `BC` is 90° clockwise. A mirrored code is
 * its rotation's letters reversed — the rotation, then a horizontal flip — so
 * `CB` is a transpose and `AD` a transverse. Lightroom's code is relative to the
 * stored pixels, camera orientation tag included.
 *
 * The mapping was checked against a contact sheet of the real catalog, including
 * the rare mirrored codes.
 */
import type { Sharp } from 'sharp';

export const ORIENTATION_CODES = ['AB', 'BC', 'CD', 'DA', 'BA', 'DC', 'CB', 'AD'] as const;
export type OrientationCode = (typeof ORIENTATION_CODES)[number];

export const UPRIGHT: OrientationCode = 'AB';

/** 2×2 matrix `[a, b, c, d]` mapping `(x, y)` to `(a·x + b·y, c·x + d·y)`, y pointing down. */
type Matrix = readonly [number, number, number, number];

const MATRIX: Record<OrientationCode, Matrix> = {
  AB: [1, 0, 0, 1],
  BC: [0, -1, 1, 0],
  CD: [-1, 0, 0, -1],
  DA: [0, 1, -1, 0],
  BA: [-1, 0, 0, 1],
  DC: [1, 0, 0, -1],
  CB: [0, 1, 1, 0],
  AD: [0, -1, -1, 0],
};

/**
 * LibRaw's `flip`, which the decoder has already applied to its output.
 *
 * dcraw's bits: 4 swaps the axes, then 2 mirrors columns and 1 mirrors rows.
 * Cameras only write 0, 3, 5 and 6.
 */
const LIBRAW_FLIP: Record<number, OrientationCode> = {
  0: 'AB',
  1: 'DC',
  2: 'BA',
  3: 'CD',
  4: 'CB',
  5: 'DA',
  6: 'BC',
  7: 'AD',
};

/** A stored value as a code; anything unrecognised, `NULL` included, is upright. */
export function normalizeOrientation(value: unknown): OrientationCode {
  return typeof value === 'string' && (ORIENTATION_CODES as readonly string[]).includes(value)
    ? (value as OrientationCode)
    : UPRIGHT;
}

export function orientationFromLibrawFlip(flip: unknown): OrientationCode {
  return typeof flip === 'number' ? (LIBRAW_FLIP[flip] ?? UPRIGHT) : UPRIGHT;
}

/** Whether the code swaps width and height. */
export function isQuarterTurn(code: OrientationCode): boolean {
  return MATRIX[code][0] === 0;
}

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
  ];
}

function codeOf(m: Matrix): OrientationCode {
  const code = ORIENTATION_CODES.find((c) => MATRIX[c].every((v, i) => v === m[i]));
  if (!code) throw new Error(`not an orientation matrix: ${m.join(',')}`);
  return code;
}

/**
 * The transform still owed to an image that already has `applied` done to it,
 * so that the result shows as `target`. Orthogonal, so the inverse is the transpose.
 */
export function remainingOrientation(
  target: OrientationCode,
  applied: OrientationCode,
): OrientationCode {
  const a = MATRIX[applied];
  return codeOf(multiply(MATRIX[target], [a[0], a[2], a[1], a[3]]));
}

/**
 * Each code as a horizontal flop followed by a clockwise turn. sharp mirrors
 * before it rotates whatever order the calls are made in, so this is the only
 * decomposition it can express.
 */
const SHARP_STEPS: Record<OrientationCode, { flop: boolean; angle: 0 | 90 | 180 | 270 }> = {
  AB: { flop: false, angle: 0 },
  BC: { flop: false, angle: 90 },
  CD: { flop: false, angle: 180 },
  DA: { flop: false, angle: 270 },
  BA: { flop: true, angle: 0 },
  DC: { flop: true, angle: 180 },
  CB: { flop: true, angle: 270 },
  AD: { flop: true, angle: 90 },
};

/** Add the transform for `code` to a sharp pipeline. */
export function applyOrientation(pipeline: Sharp, code: OrientationCode): Sharp {
  const { flop, angle } = SHARP_STEPS[code];
  if (flop) pipeline.flop();
  if (angle) pipeline.rotate(angle);
  return pipeline;
}

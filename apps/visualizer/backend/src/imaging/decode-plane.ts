/**
 * Decoding image files to an interleaved `Plane`.
 *
 * The colourspace pin is load-bearing: libvips promotes a 1-channel image to 3
 * channels on `.raw()` unless told otherwise, so an unpinned decode silently
 * changes the input to every downstream pixel calculation. Callers that
 * greyscale themselves (phash, frame substance) must decode `auto` so a
 * single-channel file stays single-channel; CLIP always wants three.
 */
import sharp from 'sharp';
import type { Plane } from './pil-resample.js';

export interface DecodePlaneOptions {
  /** `auto` keeps a 1-channel file at one channel; `srgb` forces three. */
  colourspace?: 'auto' | 'srgb';
  removeAlpha?: boolean;
  /** Cached previews of full-size RAW renders exceed sharp's default ceiling. */
  limitInputPixels?: boolean;
}

/** `path` may be the file's bytes: sharp decodes them the same way. */
export async function decodePlaneFromFile(
  path: string | Buffer,
  options: DecodePlaneOptions = {},
): Promise<Plane> {
  const { colourspace = 'auto', removeAlpha = false, limitInputPixels = true } = options;
  const sharpOptions = { limitInputPixels };

  let target: 'b-w' | 'srgb' = 'srgb';
  if (colourspace === 'auto') {
    const meta = await sharp(path, sharpOptions).metadata();
    if (meta.channels === 1) target = 'b-w';
  }

  let pipeline = sharp(path, sharpOptions);
  if (removeAlpha) pipeline = pipeline.removeAlpha();
  const { data, info } = await pipeline
    .toColourspace(target)
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

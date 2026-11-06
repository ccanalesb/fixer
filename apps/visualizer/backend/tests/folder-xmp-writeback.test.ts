import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ExifTool } from 'exiftool-vendored';
import { pathUnderCatalogRoot } from '../src/folder/path-under-root.js';
import { atomicReplaceFileAsync } from '../src/folder/xmp-atomic-write.js';

let dir: string;
let root: string;
let tool: ExifTool;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-xmp-write-'));
  root = join(dir, 'catalog');
  mkdirSync(root, { recursive: true });
  tool = new ExifTool({ maxProcs: 1 });
});

afterEach(async () => {
  await tool.end();
  rmSync(dir, { recursive: true, force: true });
});

describe('folder write-back path safety', () => {
  it('refuses paths outside the catalog root', () => {
    expect(pathUnderCatalogRoot(root, join(root, 'a.jpg'))).toBe(true);
    expect(pathUnderCatalogRoot(root, join(dir, 'outside.jpg'))).toBe(false);
  });

  it('writes atomically under the catalog root', async () => {
    const photo = join(root, 'pic.jpg');
    await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toFile(photo);
    const outcome = await atomicReplaceFileAsync(root, photo, [], async (tempPath) => {
      await tool.write(tempPath, { Rating: 2 }, ['-overwrite_original']);
    });
    expect(outcome).toBe('ok');
    const tags = await tool.read(photo);
    expect(Number(tags.Rating)).toBe(2);
  });

  it('does not write when the target path escapes the root', async () => {
    const outside = join(dir, 'escape.jpg');
    writeFileSync(outside, 'x');
    const outcome = await atomicReplaceFileAsync(root, outside, [], async () => {});
    expect(outcome).toBe('outside');
    expect(readFileSync(outside, 'utf8')).toBe('x');
  });
});

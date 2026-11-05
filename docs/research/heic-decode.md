# Decoding HEIC/HEIF (HEVC) in the Node backend

Research question: how can the visualizer backend (Node 24, TypeScript, Tauri desktop with a Node sidecar on macOS, Windows and Linux — ADR-0022) turn iPhone-style HEIC files into pixels for the vision cache (~1024 px JPEG + phash), given that the bundled **sharp** (libvips 8.17.3) reads HEIF metadata but cannot decode HEVC-coded pixels?

Method: primary sources (sharp/libvips build scripts, libheif and libde265 docs and headers, npm registry, Microsoft platform docs) plus **empirical tests on this machine** (darwin arm64, Node v24.14.1, Apple Silicon). Numbers labelled *measured* were taken here; Windows and Linux decode times and real iPhone file behaviour were **not** measured in this session.

---

## Verdict (recommendation not decided)

| Approach | Cross-platform | Fits packaged sidecar | Decode ~12 MP (this Mac) | Peak RAM (this Mac) | Extra bundle | HEVC decode |
|---|---|---|---|---|---|---|
| **sharp (status quo)** | yes | already shipped | metadata ~2 ms; pixels **fail** | — | 0 | **no** (no HEVC in prebuild) |
| **libheif-js / heic-decode (WASM + libde265)** | yes | yes (pure npm + wasm) | **~390 ms** full RGBA | **~213 MB** | **~1.5 MB wasm** (+ npm tree ~9 MB on disk) | yes (LGPL stack) |
| **macOS `sips` / ImageIO** | macOS only | spawn system binary | **~127–161 ms** full JPEG; **~390 ms** `-Z 1024` | **~25 MB** | 0 | yes (OS, patent via Apple) |
| **ffmpeg (Homebrew build here)** | yes if binary shipped | separate binary per OS | **~133 ms** full JPEG | not measured | tens of MB per binary | yes (platform codecs) |
| **Custom global libvips + libde265 for sharp** | sharp docs discourage | **not supportable** for packaged app | not measured | not measured | rebuild sharp | yes |
| **Windows WIC + store extensions** | Windows only | OS + user-installed extensions | not measured | not measured | 0 | yes if extensions installed |
| **Linux distro libheif** | varies | not bundled by default | not measured | not measured | 0 | yes if packages installed |

**Leading candidates for a product decision:** (1) **WASM libheif** (`heic-decode` / `libheif-js`) for one code path on all three desktop targets, feeding decoded RGBA or a temp buffer into existing **sharp** resize/JPEG for the vision cache; (2) a **hybrid** that calls **macOS `sips`** (and optionally **ffmpeg** where present) when available, with WASM fallback on Linux and minimal Windows installs. **Not decided here** — patent/licensing review and a real iPhone HEIC corpus test are still needed.

---

## Why sharp fails today

The prebuilt libvips inside `@img/sharp-libvips` is compiled with libheif **without any HEVC decoder** and with **plugin loading disabled**:

```cmake
-DENABLE_PLUGIN_LOADING=0 ... -DWITH_LIBDE265=0 -DWITH_X265=0
```

Source: [`lovell/sharp-libvips` `build/posix.sh`](https://github.com/lovell/sharp-libvips/blob/main/build/posix.sh) (libheif cmake invocation).

sharp’s own output docs state that patent-encumbered HEIC using `hevc` compression needs a globally installed libvips built with libheif, **libde265 and x265** — and that custom global libvips is unsupported for the packaged scenarios this app uses ([sharp `heif` output docs](https://github.com/lovell/sharp/blob/main/docs/src/content/docs/api-output.md)).

*Measured* on a HEVC HEIC produced with `sips -s format heic` from a 4032×3024 upscale:

- `sharp(...).metadata()` succeeds in ~2 ms; reports `format: 'heif'`, `compression: 'hevc'`, dimensions, and a small EXIF buffer.
- `sharp(...).raw()` fails with `heif: Error while loading plugin: Support for this compression format has not been built in (11.6003)`.

AVIF and WebP still decode through sharp because those codecs are built into this libvips stack; only **HEVC inside HEIF** is missing.

---

## What the vision pipeline needs

From `apps/visualizer/backend` today:

- **Vision cache** (`vision/vision-cache.ts`, `imaging/image-prep.ts`): decode (or reuse a sidecar), apply **catalog orientation** via `applyOrientation`, resize to `VISION_MAX_DIMENSION` (default 1024) with sharp, write JPEG, compute **phash** via `decodePlaneFromFile` → `phash`.
- **HEIC is not RAW**: `getViewablePathManaged` passes `.heic` through unchanged; there is no sidecar shortcut like RAW+JPEG.
- **phash** uses sharp in `decodePlaneFromFile`; a HEIC path must either decode to something sharp can read or bypass sharp for the initial decode step.

So the gap is specifically **HEVC pixel decode**; downstream resize/encode can stay on sharp once pixels exist.

---

## Candidate survey

### 1. libheif-js / heic-decode / heic-convert (Emscripten libheif + libde265)

| Package | Version (npm, 2026-11-05) | Licence | Notes |
|---|---|---|---|
| [`libheif-js`](https://www.npmjs.com/package/libheif-js) | 1.23.5 | LGPL-3.0 | Emscripten libheif; `wasm-bundle` includes ~**1.46 MB** `libheif.wasm` (*measured*). Strings in the wasm name **libde265 HEVC decoder**. |
| [`heic-decode`](https://www.npmjs.com/package/heic-decode) | 2.1.0 | ISC | Thin wrapper; depends on `libheif-js/wasm-bundle`. Exports `decode()` and `decode.all()`. |
| [`heic-convert`](https://www.npmjs.com/package/heic-convert) | 2.1.0 | ISC | decode + JPEG encode in JS; slower than decode-only + sharp JPEG. |

**Platform coverage:** Node and browser WASM — same artefact on macOS, Windows and Linux sidecars.

**Performance (*measured*, 4032×3024 HEVC HEIC, ~1.0 MB file, warm process):**

| Step | Median time |
|---|---|
| `heic-decode` → full RGBA | **~387–397 ms** |
| `libheif-js` `display()` → RGBA | **~336–339 ms** |
| `heic-convert` → JPEG buffer | **~803–950 ms** |
| Cold process `heic-decode` (includes wasm init) | **~387 ms** decode; wasm bundle load **~17 ms** |

Peak RSS for one full decode (*measured*, `/usr/bin/time -l`): **~213 MB**.

**Bundle size:** `libheif.wasm` **1 463 506 bytes**; `node_modules/libheif-js` **~8.7 MB** on disk (*measured* in a throwaway install). Only the wasm + loader need ship in production if deduped.

**Licence / patents:** libheif and libde265 are **LGPL-3.0** ([libde265 COPYING](https://github.com/strukturag/libde265/blob/master/COPYING)). HEVC is patent-encumbered; sharp’s docs call this out for HEIC. Distribution of a software HEVC decoder (libde265 in WASM) is a **legal/product** question, not settled in this note — same class of issue as shipping ffmpeg with HEVC enabled.

**Embedded preview shortcut:** libheif exposes thumbnail APIs (`heif_image_handle_get_number_of_thumbnails`, `heif_image_handle_get_thumbnail` in [`heif_aux_images.h`](https://github.com/strukturag/libheif/blob/master/libheif/api/libheif/heif_aux_images.h)). The high-level npm wrappers used here do not expose them; you would call libheif-js’s decoder or extend the pipeline. *Measured on this Mac:* neither `sips`-generated 12 MP HEIC nor `/System/Library/Wallpapers/.default/DefaultAerial.heic` (~4096×2160) returned `PreviewImage` / `ThumbnailImage` via ExifTool — **0 bytes**. So the preview shortcut is **plausible for iPhone masters** (Apple typically stores auxiliary thumbnails) but **was not verified** on a real device export in this session. When a thumbnail exists and is ≥1024 px (or quality is acceptable smaller), decoding the thumbnail item avoids full-resolution HEVC work.

**Orientation (`irot` / `imir`):** libheif lists **image transformations (crop, mirror, rotate)** as supported features ([libheif README](https://github.com/strukturag/libheif/blob/master/README.md)). `heif_decode` / `display()` returns oriented bitmaps suitable for RGB display. The app still applies **Lightroom/catalog orientation** in `compressImage` separately (`orientation.ts`); folder-catalog EXIF orientation must remain consistent with issue 506’s reader. sharp’s HEIF metadata includes `autoOrient` dimensions even when pixel decode fails (*measured*).

**Multi-image HEIC:** libheif selects a **primary** image (`heif_context_get_primary_image_handle`, `heif_image_handle_is_primary_image` — [libheif README](https://github.com/strukturag/libheif/blob/master/README.md)). `heic-decode.all()` returned **1** image for both test files (*measured*). Burst/Live Photo containers can hold multiple items; default **primary** matches “the photo” for catalog purposes; Live Photo **video** is a separate `.mov`, not decoded here.

**Operational notes:** libheif’s maintainers report heavy security churn ([libheif README, funding note](https://github.com/strukturag/libheif/blob/master/README.md)); pinning and monitoring advisories matters if WASM is bundled.

### 2. macOS `sips` / ImageIO (native)

**Platform coverage:** macOS only (Tauri sidecar on Mac can `execFile` `/usr/bin/sips`).

*Measured* on the same 4032×3024 HEVC HEIC:

| Operation | Median time | Peak RSS |
|---|---|---|
| Full JPEG export | **~127–161 ms** | **~25 MB** |
| `-Z 1024` JPEG (fits vision max edge) | **~394 ms** | not measured |

**Pros:** fast, low memory, no extra npm weight, uses Apple’s licensed HEVC stack.

**Cons:** not available on Windows/Linux sidecars; subprocess + temp files; error surfaces are stderr strings; sandboxed installs must allow executing `/usr/bin/sips`.

### 3. ffmpeg

*Measured* on this Mac (ffmpeg from PATH, HEVC via platform codecs): **~133 ms** to write one full JPEG frame from the 12 MP HEIC.

**Platform coverage:** good **if** a compatible ffmpeg binary is shipped or assumed (not true on minimal Linux).

**Licence:** depends on build flags (many builds LGPL/GPL + non-free codecs). Patent exposure for HEVC same as other software decoders.

**Not measured:** Windows/Linux timings, static binary size in this repo’s packaging layout.

### 4. Custom libvips / sharp rebuild with libde265

The upstream knob exists (`WITH_LIBDE265=1`), but sharp explicitly steers away from relying on custom global libvips for desktop distribution, and the project already rejected custom libvips for RAW ([`docs/research/nodejs-raw-clip-whash-feasibility.md`](nodejs-raw-clip-whash-feasibility.md) §1.2). Rebuilding `@img/sharp-libvips` with libde265 would enlarge every sharp install, raise LGPL compliance work, and **still** leave HEVC patent questions.

**Conclusion:** same category as “custom libvips for RAW” — **not a supportable default** for the Tauri sidecar.

### 5. Windows Imaging Component (WIC) + extensions

Microsoft documents HEIF/HEIC support via optional **HEIF Image Extension** and, for HEVC-coded stills, **HEVC Video Extensions** from the Microsoft Store ([HEIF image extension](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/heif-extension)).

**Platform coverage:** Windows 10/11 when extensions are installed — **not guaranteed** on fresh or locked-down machines.

**Integration:** Node has no first-party WIC binding in the current backend; would need edge-native, PowerShell, or a small helper. **Not measured** in this session.

### 6. Linux system libheif / distro packages

Many desktops install `libheif` + `libde265` via packages, but **minimal/server and Flatpak-style bundles do not**. There is no equivalent of macOS `sips` in the base image. **Not measured** here.

### 7. @imagemagick/magick-wasm

ImageMagick can decode HEIC when built with libheif; the project already uses magick-wasm as a **slow RAW fallback** in research. It is a possible unified decoder but adds a large WASM stack and was **not benchmarked for HEIC** in this session.

---

## Embedded thumbnail vs full decode for ~1024 px vision cache

| Source | Finding |
|---|---|
| Vision cache target | Longest edge **1024** (`VISION_MAX_DIMENSION`); JPEG **~50–135 KB** typical (`vision-cache.ts` header comment). |
| Full decode + sharp resize | Always correct resolution; **~390 ms** WASM or **~160 ms** `sips` full + sharp resize on this Mac. |
| `sips -Z 1024` | Single step to capped JPEG (**~394 ms** *measured*) — competitive with WASM full decode + resize, macOS only. |
| Embedded thumbnail | libheif can decode linked thumbnail items without touching the primary HEVC frame ([`heif_aux_images.h`](https://github.com/strukturag/libheif/blob/master/libheif/api/libheif/heif_aux_images.h)). iPhone files often include them; **not confirmed** on samples used here. Risk: thumbnail smaller than 1024 or heavily compressed → vision/CLIP quality loss; may still be acceptable for phash if consistent. |
| ExifTool `PreviewImage` | **0 bytes** on test files (*measured*); not a reliable generic extractor without deeper HEIF item walk. |

---

## Suggested integration shapes (for implementers, not chosen here)

1. **WASM gate in `decodePlaneFromFile` / a small `heic-decode.ts`:** if sharp metadata says `heif` + `hevc`, decode via `heic-decode`, wrap pixels in sharp from raw buffer, then existing pipelines unchanged.
2. **Platform fast path:** `process.platform === 'darwin'` → `sips` to temp JPEG, then sharp; else WASM.
3. **Thumbnail-first:** probe libheif for thumbnail handle; if width/height ≥ min threshold, decode thumbnail only; else full primary.

---

## Empirical test fixtures (this machine)

| File | Provenance | Dimensions | Role |
|---|---|---|---|
| `/var/folders/.../heic-bench-*/sample.heic` | `sips -z 3024 4032` + `sips -s format heic` from project PNG fixture | 4032×3024 HEVC | 12 MP timing |
| `/System/Library/Wallpapers/.default/DefaultAerial.heic` | macOS stock wallpaper | 4096×2160 HEVC | Real Apple HEIC; ~**832 ms** one-shot `heic-decode` (*measured*) |

---

## References

- [sharp-libvips libheif build (no libde265)](https://github.com/lovell/sharp-libvips/blob/main/build/posix.sh)
- [sharp HEIF / HEVC output note](https://github.com/lovell/sharp/blob/main/docs/src/content/docs/api-output.md)
- [libheif README — features, primary image, transforms](https://github.com/strukturag/libheif/blob/master/README.md)
- [libheif auxiliary images / thumbnails API](https://github.com/strukturag/libheif/blob/master/libheif/api/libheif/heif_aux_images.h)
- [libde265 licence](https://github.com/strukturag/libde265/blob/master/COPYING)
- [libheif-js npm](https://www.npmjs.com/package/libheif-js)
- [heic-decode npm](https://www.npmjs.com/package/heic-decode)
- [Microsoft HEIF image extension](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/heif-extension)
- [ADR-0022 Tauri + Node sidecar](../../docs/adr/0022-desktop-app-is-tauri-with-a-node-sidecar.md)

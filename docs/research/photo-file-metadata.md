# Reading capture date, size and EXIF from photo files in Node

Research for folder-catalog ingestion: how a Node 24 / TypeScript backend can populate an `images`-style row from a file path alone (capture instant with sub-second and time zone when present, dimensions, orientation, camera/lens/exposure, GPS). Compares libraries against the raster set (JPEG, HEIC/HEIF, PNG, TIFF) and every RAW extension in `apps/visualizer/backend/src/imaging/raw-decode.ts`.

Method: primary sources (official docs, library READMEs, npm registry, ExifTool format matrix, CIPA EXIF DC-008), plus **measurements on this machine** (darwin arm64, Node v24.14.1) where noted.

---

## TL;DR

- **No single pure-JS library covers the full format matrix.** `exifr` is fast and header-oriented for JPEG / HEIC / PNG / TIFF (plus Phase One `.iiq` as TIFF) but **does not parse Canon CR3, Fujifilm RAF, Sigma X3F, or most vendor RAW containers** ([exifr README](https://github.com/MikeKovarik/exifr/blob/master/README.md)). **`sharp` `metadata()`** already ships in the backend and reads dimensions/orientation/raw EXIF buffers for JPEG, PNG, GIF, TIFF, WebP, SVG, and HEIF/AVIF when libvips supports them — **not** the project's RAW extensions ([sharp `metadata()`](https://sharp.pixelplumbing.com/api-input#metadata), [empirical format table](#sharp-metadata)).
- **`exiftool-vendored`** (MIT) wraps a **vendored Perl ExifTool** (~**21 MB** unpacked for `exiftool-vendored.pl` on npm install; ExifTool itself **Artistic / GPL**) and reads **all target RAW types including CR3, RAF, X3F** ([ExifTool supported formats](https://exiftool.org/#supported)). It exposes **`ExifDateTime`** with sub-second precision and time-zone inference from `OffsetTime*`, GPS, etc. ([DATES.md](https://github.com/photostructure/exiftool-vendored.js/blob/main/docs/DATES.md)).
- **`libraw-wasm`** (already used for decode) exposes rich **`metadata()`** after `open()` — make/model, exposure, GPS, `timestamp` as `Date`, dimensions — for LibRaw-supported RAWs, but **`open()` reads the whole file into WASM** (same cost class as decode) and **`.x3f` does not decode** in this stack ([prior LibRaw measurement doc](./nodejs-raw-clip-whash-feasibility.md), [TypeScript `Metadata` interface](https://www.npmjs.com/package/libraw-wasm) in package typings).
- **Sub-second + offset:** EXIF 2.32 defines **`SubSecTimeOriginal`** (ASCII fractional seconds) and **`OffsetTimeOriginal`** (`±HH:MM`) alongside **`DateTimeOriginal`** ([CIPA DC-008-2019 PDF](https://fotomagazin.hu/wp-content/uploads/2020/05/CIPA_DC_008_EXIF_2019.pdf), [ExifTool tag reference](https://exiftool.org/TagNames/EXIF.html)). **`exifr`** parses those tag names but **`reviveValues` only turns main date tags into `Date` objects** — callers merge sub-second and offset strings themselves ([exifr `reviveValues`](https://github.com/MikeKovarik/exifr/blob/master/README.md#optionsrevivevalues)). **`exiftool-vendored`** merges into **`ExifDateTime.millisecond`** and **`tzoffset` / `zone`** when possible.
- **Without EXIF capture date:** prefer **`DateTimeOriginal` → XMP `CreateDate` → other embedded dates** before filesystem times. **`fs.stat` `mtime`** usually reflects last content write (often **changed on copy/export**). **`birthtime`** is creation time where the OS exposes it; on Node it **may be `ctime` or the Unix epoch** when unavailable ([Node `fs.Stats` birthtime](https://nodejs.org/docs/latest-v24.x/api/fs.html#statsbirthtime)). ExifTool also surfaces **`FileModifyDate`** / **`FileCreateDate`** from the filesystem ([exiftool-vendored DATES.md](https://github.com/photostructure/exiftool-vendored.js/blob/main/docs/DATES.md)).
- **Directory walk at ~50k scale:** recursive **`fs.opendir`** over **30,422 files** in this repo tree took **~463 ms** on local SSD (Node 24); **`readdir`** on a 48-file subtree was faster. Expect **roughly sub-second to low seconds** for 50k entries on SSD; **network shares** add latency per directory and may dominate — not measured here (no NAS fixture).
- **Per-file metadata timing (this machine):** after ExifTool warm-up, **`exifr.parse` ~0.3–1.5 ms**, **`sharp().metadata()` ~0.5–1 ms**, **`exiftool.read` ~6–85 ms** (first call ~85 ms) on small JPEG derivatives **stripped of camera EXIF**; PNG test fixture: exifr **~1 ms**, sharp **~0.5 ms**, exiftool **~7 ms**. **50k × 7 ms ≈ 6 min** single-thread ExifTool vs **~25 s** at 0.5 ms for exifr-class readers (order-of-magnitude only).

### Recommendation (for a later grilling ticket — not a decision here)

Use a **split strategy** aligned with ADR-0022 packaging:

1. **`exifr` (or `sharp` + optional EXIF buffer parse)** for **JPEG / PNG / TIFF / HEIC** — minimal bundle impact, chunked header reads, MIT license.
2. **`libraw-wasm` `metadata()`** for **LibRaw-supported RAW** when the pipeline already touches the file (reuse one `open()` for metadata + optional half-size decode), accepting **whole-file read** and **no X3F**.
3. **`exiftool-vendored` as fallback** (or dedicated worker pool) for **CR3 / RAF / X3F**, **maker-note-heavy** fields, and **timezone backfill** when GPS/`OffsetTime*` matter for burst stacking — budget **~21 MB** Perl tree and **Artistic/GPL** compliance for the bundled ExifTool binary ([`exiftool-vendored.pl` README](https://www.npmjs.com/package/exiftool-vendored.pl)).

Alternative: **ExifTool-only** ingestion for folder catalog — simplest mentally and widest coverage, at the cost of **process overhead**, **license**, and **packaging size**.

---

## Required fields vs sources

| Field | Typical EXIF / maker tags | Notes |
| --- | --- | --- |
| Capture instant | `DateTimeOriginal`, `SubSecTimeOriginal`, `OffsetTimeOriginal` | Also XMP `CreateDate`, QuickTime `CreateDate` in HEIC/CR3 |
| Width / height | `ExifImageWidth` / `ImageWidth`, `ImageHeight` | RAW: often from metadata block or decoded size |
| Orientation | `Orientation` (1–8) | `sharp` exposes numeric EXIF orientation; LibRaw `flip` |
| Camera | `Make`, `Model` | MakerNotes for lens body variants |
| Lens | `LensModel`, `LensSpecification`, vendor tags | ExifTool strongest on makernotes |
| Focal length | `FocalLength`, `FocalLengthIn35mmFormat` | |
| Aperture | `FNumber` | |
| Shutter | `ExposureTime` | |
| ISO | `ISO` / `PhotographicSensitivity` | |
| GPS | `GPSLatitude`, `GPSLongitude`, … | |

Burst stacking depends on **monotonic capture times with sub-second discrimination** and **consistent time zone** when comparing gaps — treat naïve `Date` (local wall clock without offset) as hazardous when `OffsetTimeOriginal` exists ([CIPA DC-008-2019](https://fotomagazin.hu/wp-content/uploads/2020/05/CIPA_DC_008_EXIF_2019.pdf)).

---

## Candidate comparison

### `exifr` (npm `exifr@7.1.3`, MIT)

| Aspect | Detail |
| --- | --- |
| **Formats** | **JPEG, PNG, HEIC/HEIF, AVIF, TIFF, IIQ** ([README format table](https://github.com/MikeKovarik/exifr/blob/master/README.md)). **No CR3, RAF, X3F, NEF-as-RAW-container**, etc. GitHub issues: **RAF unsupported** ([#unknown](https://github.com/MikeKovarik/exifr/issues)), **HEIC edge cases** (iOS adaptive HDR). |
| **I/O** | **Chunked** by default (`firstChunkSizeNode: 512`, 64 KiB chunks, limit 5) — stops early when picked tags found ([README options](https://github.com/MikeKovarik/exifr/blob/master/README.md)). `multiSegment: true` forces full file. |
| **Native deps** | **None** (pure JS). ~73 KB full bundle ([README](https://github.com/MikeKovarik/exifr/blob/master/README.md)). |
| **Maintenance** | Last npm publish **2022-05-01** ([npm `exifr`](https://www.npmjs.com/package/exifr)); GitHub still receives issues in 2024–2025. |
| **Dates** | Parses **`OffsetTimeOriginal`**, **`SubSecTimeOriginal`** keys ([source `tiff-exif-keys.mjs`](https://github.com/MikeKovarik/exifr/blob/master/src/dicts/tiff-exif-keys.mjs)). With **`reviveValues: true`**, main dates become **`Date`** (UTC interpretation of EXIF local time — **does not apply offset automatically**); sub-second remains a **separate string** unless the app combines them. |
| **GPS / exposure** | Supported via default TIFF/EXIF/GPS blocks when enabled. |

### `exiftool-vendored` + `exiftool-vendored.pl` (MIT wrapper, Perl ExifTool Artistic/GPL)

| Aspect | Detail |
| --- | --- |
| **Formats** | **All project RAW extensions** (e.g. **CR3, RAF, X3F, ARW, NEF, ORF, RW2, SRW, DNG, …**) plus **JPEG, PNG, TIFF, HEIC/HEIF** ([format matrix](https://exiftool.org/#supported)). |
| **I/O** | Spawns persistent **`exiftool` Perl** child(ren); reads **as much of the file as ExifTool needs** (often header-only for JPEG; **RAW may scan more**, large QuickTime samples noted in [`exiftool-vendored.pl` README](https://www.npmjs.com/package/exiftool-vendored.pl)). |
| **Size / native** | **`exiftool-vendored.pl` ~21 MB** unpacked (this machine, npm install); JS wrapper ~2.5 MB. **Perl runtime embedded** — not pure JS. |
| **Maintenance** | Active (**exiftool-vendored@39.x**, 2026 on npm). |
| **Dates** | **`ExifDateTime`** with **`millisecond`** (sub-second), **`tzoffset`**, **`zone`**; inference order: explicit `OffsetTime*`, GPS → tz lookup, UTC deltas ([DATES.md](https://github.com/photostructure/exiftool-vendored.js/blob/main/docs/DATES.md)). |
| **Licence** | npm packages **MIT**; bundled ExifTool **Artistic / GPL** ([ExifTool](https://exiftool.org/), [`exiftool-vendored.pl` spec](https://www.npmjs.com/package/exiftool-vendored.pl)). |

### `sharp` `metadata()` (already in backend, Apache-2.0 + libvips)

| Aspect | Detail |
| --- | --- |
| **Formats** | On this build, **input file**: JPEG, PNG, WebP, TIFF, GIF, SVG, HEIF (incl. AVIF), Vips ([`sharp.format` run](#sharp-metadata)). **RAW file input disabled** (`raw.input.file: false`; `dcraw` false). Confirmed **CR3/ORF/etc. fail** in [raw feasibility doc](./nodejs-raw-clip-whash-feasibility.md). |
| **I/O** | **Header-only**, no pixel decode ([metadata API](https://sharp.pixelplumbing.com/api-input#metadata)). Returns **`width`/`height`**, **`orientation`**, raw **`exif`/`xmp`/`icc` buffers** — not parsed tag objects. |
| **Dates** | App must parse **`exif` buffer** (e.g. via `exifr.parse(exifBuffer)`) — sharp does not expose `DateTimeOriginal` directly. |
| **Role** | **Dimensions + orientation** for rasters; pair with `exifr` for tag objects. |

#### `sharp` metadata

Measured on Node v24.14.1 / darwin arm64:

```json
"heif": { "input": { "file": true, "fileSuffix": [".avif"] } }
```

HEIC/HEIF decode is via the **`heif`** loader ([sharp docs](https://sharp.pixelplumbing.com/api-input#metadata)); suffix list in `sharp.format` is not exhaustive of all extensions libvips accepts.

### `libraw-wasm` `metadata()` (already in backend)

| Aspect | Detail |
| --- | --- |
| **Formats** | Same as LibRaw decode set used in Fixer (see `RAW_EXTENSIONS` in `raw-decode.ts`). **`.x3f` fails**; CR3/SR2 dimension edge cases documented in [raw feasibility doc](./nodejs-raw-clip-whash-feasibility.md). |
| **I/O** | **`readFile` entire RAW** → `open()` in WASM worker → `metadata()`. Not header-only. **~200 MB/worker** if instances are not disposed ([backend `decodeRaw` comment](https://github.com/ccanalesb/fixer/blob/master/apps/visualizer/backend/src/imaging/libraw/decode.ts)). |
| **Fields** | **`Metadata`**: `width`, `height`, `flip`, `camera_make`, `camera_model`, `iso_speed`, `shutter`, `aperture`, `focal_len`, **`timestamp: Date`**, optional **`gps_data`**, **`lens`**, maker blocks ([typings on npm](https://www.npmjs.com/package/libraw-wasm)). **No EXIF 2.32 `OffsetTime*` strings** — LibRaw **`timestamp`** is a single instant; sub-second/time-zone semantics depend on LibRaw's internal parsing. |
| **Role** | Good **single-library path for TIFF-based RAW** already decoded for vision; avoid double `open()` when both metadata and preview are needed. |

### Other pure-JS options (brief)

| Library | Verdict |
| --- | --- |
| **`piexifjs` / similar** | JPEG-only EXIF read/write; insufficient for RAW/HEIC ([typical npm descriptions](https://www.npmjs.com/search?q=piexif)). |
| **`metadata-extractor`** | Java-first; Node ports are unmaintained or partial vs ExifTool. |
| **Manual `exif` buffer parse** | Possible with `sharp` + `exifr.parse(buffer)` for rasters only. |

---

## Files without EXIF capture date

Priority order suggested for folder catalog:

1. **Embedded metadata:** `DateTimeOriginal` → `CreateDate` (EXIF/XMP) → `DateTimeDigitized` / `ModifyDate` (weaker — often import/edit time).
2. **Filesystem via ExifTool:** `FileCreateDate` / `FileModifyDate` ([ExifTool file tags](https://exiftool.org/TagNames/EXIF.html)).
3. **Node `fs.stat` / `fs.promises.stat`:**  
   - **`mtime`**: last modification; **copy tools often set to copy time** (especially cloud sync, “export”, zip unpack).  
   - **`birthtime`**: creation when supported; **macOS APFS** often preserves; **Linux** may lack true birth time; Node documents fallback to **`ctime` or `1970-01-01`** ([Node fs stats birthtime](https://nodejs.org/docs/latest-v24.x/api/fs.html#statsbirthtime)).  
   - **`ctime`**: metadata change — **not capture time**.

**Reliability after copy/sync:** treat filesystem dates as **last-resort hints**; never equal to `DateTimeOriginal` for burst logic unless the user explicitly opts in.

---

## Measurements (this machine)

**Environment:** darwin arm64, Node v24.14.1, local SSD. Script: `/tmp/metadata-bench/bench.mjs` (throwaway, not shipped).

### Per-file metadata (ms)

| Sample | exifr | sharp `metadata()` | exiftool `read()` |
| --- | ---: | ---: | ---: |
| 3× Photos.app JPEG derivatives (no camera EXIF remaining) | 0.31–1.49 | 0.52–0.97 | 6.4–85 (cold 85) |
| PNG fixture `tiny_7x5.png` | 0.97 | 0.45 | 7.18 |

**Field presence:** derivatives had **only width/height** in exiftool; **no EXIF capture tags** (expected for stripped syndication JPEGs). PNG fixture: dimensions only.

**Extrapolation (50k folder, SSD, order-of-magnitude):**

| Reader | ~ms/file (warm) | ~50k total (single thread) |
| --- | ---: | ---: |
| exifr / sharp header | 0.5–1 | **25–50 s** |
| exiftool-vendored | 6–10+ | **5–15 min** (tune with `maxProcs`, [README performance](https://github.com/photostructure/exiftool-vendored.js/blob/main/README.md)) |

**Not measured:** 50k-file tree on **network share**; ExifTool on **full-size CR3/RAF** bodies.

### Recursive directory walk

| Root | Files counted | `fs.opendir` recursive | `fs.readdir` recursive |
| --- | ---: | ---: | ---: |
| `/Users/ccanales/projects/lightroom-tagger` | 30,422 | **463 ms** | (not run at this scale) |
| Photos syndication subtree | 48 | 2.06 ms | 0.74 ms |

**~50k files on SSD:** scale linearly → **~750 ms–1 s** walk alone is plausible; metadata dominates total ingest time.

---

## Packaging context (ADR-0022)

The desktop app ships **stock Node 24** + production **`node_modules`** per OS triple ([ADR-0022](../adr/0022-desktop-app-is-tauri-with-a-node-sidecar.md)). Adding **`exiftool-vendored.pl`** increases the bundle by **~21 MB** plus another long-lived process model. **`exifr`** adds negligible size. **`libraw-wasm`** is already paid for decoding.

---

## References

- [exifr README](https://github.com/MikeKovarik/exifr/blob/master/README.md) — formats, chunked I/O, `reviveValues`
- [exiftool-vendored README](https://github.com/photostructure/exiftool-vendored.js/blob/main/README.md) — API, performance, `ExifDateTime`
- [exiftool-vendored DATES.md](https://github.com/photostructure/exiftool-vendored.js/blob/main/docs/DATES.md) — timezone inference, sub-second
- [exiftool-vendored.pl (npm)](https://www.npmjs.com/package/exiftool-vendored.pl) — vendored Perl size, patches
- [ExifTool home & supported formats](https://exiftool.org/#supported)
- [ExifTool EXIF tag names (OffsetTimeOriginal, SubSecTimeOriginal)](https://exiftool.org/TagNames/EXIF.html)
- [sharp `metadata()`](https://sharp.pixelplumbing.com/api-input#metadata)
- [libraw-wasm (npm)](https://www.npmjs.com/package/libraw-wasm)
- [CIPA DC-008-2019 EXIF (OffsetTimeOriginal, SubSecTimeOriginal)](https://fotomagazin.hu/wp-content/uploads/2020/05/CIPA_DC_008_EXIF_2019.pdf)
- [Node.js `fs.Stats` birthtime / mtime](https://nodejs.org/docs/latest-v24.x/api/fs.html#stat-object)
- [Fixer RAW feasibility measurements](./nodejs-raw-clip-whash-feasibility.md) — exifr/sharp/libraw on RAW samples
- [ADR-0022: Tauri + Node sidecar](../adr/0022-desktop-app-is-tauri-with-a-node-sidecar.md)

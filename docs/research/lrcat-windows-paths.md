# How Windows Lightroom Classic catalogs store paths (Wayfinder #406)

Research for map [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382). Read-only audit — path handling fixes belong elsewhere ([#391](https://github.com/ccanalesb/lightroom-tagger/issues/391)). Code references are from `origin/master` at research time (2026-10-24).

## TL;DR

- **Separators:** On Windows, Lightroom Classic stores **`/` (forward slashes)** in `AgLibraryRootFolder.absolutePath` and `AgLibraryFolder.pathFromRoot`, not `\`. Real Win10 catalog dump: `C:/Users/human/Pictures/2010/` ([LightroomClassicCatalogReader](https://github.com/thatlarrypearson/LightroomClassicCatalogReader)); corroborated on [Lightroom Queen (2021)](https://www.lightroomqueen.com/community/threads/semi-ot-question-re-file-path-on-windows.43010/).
- **Shape:** Root `absolutePath` ends with **`/`**; nested folders use **`pathFromRoot`** like `2010-05-04/` (trailing slash). Files are **`baseName` + `.` + `extension`** only (no directory in the filename columns).
- **Local & mapped drives:** Drive letter roots look like **`C:/…/`** or **`F:/…/`** or **`Z:/…/`** in SQLite — same slash convention as macOS paths, but with a **`X:/`** prefix instead of `/Volumes/…` or `//host/share/`.
- **UNC on Windows:** Users add folders as **`\\server\share\…`** in the UI; catalogs opened on macOS often still contain **`\\nas\share`**-style roots ([Reddit 2025](https://www.reddit.com/r/Lightroom/comments/1p30gnx/lightroom_classic_invalid_path_error_when_moving/)). Whether Adobe normalizes UNC to forward slashes in the DB is **unconfirmed** (forum anecdote: Adobe “changed back-slashes to slashes” — [SpaceRex](https://forums.spacerex.co/t/lr-cat-mac-and-pc-cant-find-network-folder-location/701/11)).
- **macOS NAS vs Windows:** macOS/network imports commonly use **`//host/share/…`** (this repo’s macOS corpus). That is **not** the same string Windows UNC users describe; cross-OS catalogs need **Update Folder Location** or manual `absolutePath` edits ([Bill Lee](https://billlee.photography/fixing-lightroom-catalogs-migrated-from-windows-to-mac/)).
- **`relativePathFromCatalog`:** Relative path from the **`.lrcat` file** to the root folder (e.g. `../2010/` when catalog lives under `Pictures/Lightroom` and photos under `Pictures/2010`). Often **NULL** when the image root is on a **different volume** than the catalog ([hfiguiere format doc](https://github.com/hfiguiere/lrcat-extractor/blob/main/doc/lrcat_format.md), [Lightroom Queen](https://www.lightroomqueen.com/community/threads/semi-ot-question-re-file-path-on-windows.43010/)). Portable Win/Mac workflows keep **images in subfolders of the catalog folder** so Lightroom can resolve via relative paths ([Adobe Community](https://community.adobe.com/questions-675/lightroom-classic-catalog-on-external-ssd-from-macos-to-windows-10-unable-to-find-missing-images-956358)).
- **`reader.ts` today:** Full path = **`absolutePath` + `pathFromRoot` + `baseName` + optional `.` + `extension`** (no extra separator). **`resolveFilepath`** only rewrites paths that start with **`//`** (macOS-style NAS); Windows **`C:/…`**, **`Z:/…`**, and **`\\…`** pass through unchanged — so **`//`-style Windows rows are unconfirmed**, and **`\\` UNC** is invisible to NAS env mapping unless the OS can open the literal string.

---

## Path forms (Windows `.lrcat`)

| Scenario | Typical `AgLibraryRootFolder.absolutePath` | `pathFromRoot` | `relativePathFromCatalog` | Sources |
|----------|-------------------------------------------|----------------|---------------------------|---------|
| Local disk (C:) | `C:/Users/human/Pictures/2010/` | `2010-05-04/` | `../2010/` (when catalog and photos share a volume layout) | [LarryPearson README — full record](https://github.com/thatlarrypearson/LightroomClassicCatalogReader/blob/master/README.md) |
| Second / external drive | `F:/Pictures/` (inferred from `F:/` cleanup in same README) | `…/` with `/` | Often NULL if catalog on `C:` and photos on `F:` | [LarryPearson README](https://github.com/thatlarrypearson/LightroomClassicCatalogReader/blob/master/README.md); [Lightroom Queen — NULL on other volume](https://www.lightroomqueen.com/community/threads/semi-ot-question-re-file-path-on-windows.43010/) |
| Mapped network drive (e.g. Z:) | **`Z:/Party pics/`** (same `/` rules as `C:/`; **unconfirmed** exact sample in a public fixture) | Subfolders with `/`, trailing `/` | Usually NULL (catalog local, share remote) | Slash convention: [Lightroom Queen](https://www.lightroomqueen.com/community/threads/semi-ot-question-re-file-path-on-windows.43010/); mapped drive relink: [Bill Lee](https://billlee.photography/fixing-lightroom-catalogs-migrated-from-windows-to-mac/) |
| UNC (`\\server\share\folder`) | **`\\nas\share`** or slash variant — **unconfirmed** in a quoted SQLite row; UI path is `\\…` | **`/`** in modern catalogs per forum checks | Usually NULL | [Bill Lee](https://billlee.photography/fixing-lightroom-catalogs-migrated-from-windows-to-mac/); [Reddit UNC in catalog](https://www.reddit.com/r/Lightroom/comments/1p30gnx/lightroom_classic_invalid_path_error_when_moving/); [Adobe Community UNC vs mapped drive](https://community.adobe.com/questions-675/lightroom-classic-august-2019-parent-folder-photo-count-not-appearing-940882) |
| macOS NAS (contrast) | `//10.88.111.157/ccanales/Lightroom Server/…/` | `YYYY/MM/DD/` style with `/` | Varies | This repo macOS corpus; [posix assumptions audit](https://github.com/ccanalesb/lightroom-tagger/blob/master/docs/research/posix-assumptions-audit.md) on `origin/research/posix-assumptions` |
| Folder mounted in path (no drive letter) | Mount path with `/` (Win “folder mount”) | `/` segments | **Unconfirmed** example | [Lightroom Queen — Philippe](https://www.lightroomqueen.com/community/threads/semi-ot-question-re-file-path-on-windows.43010/) |

### Column semantics (all platforms)

| Column | Role |
|--------|------|
| `AgLibraryRootFolder.absolutePath` | Absolute path to the **root folder** Lightroom was told to import from; includes volume/drive/UNC prefix; **normally ends with `/`**. |
| `AgLibraryRootFolder.relativePathFromCatalog` | Relative path from the **catalog file** to that root; **`NULL`** when not on the same volume ([hfiguiere](https://github.com/hfiguiere/lrcat-extractor/blob/main/doc/lrcat_format.md)). |
| `AgLibraryFolder.pathFromRoot` | Path under the root to the folder containing files; **`''`** for the root-level folder row; otherwise segments like `2024/01/` with **`/`** and usually a **trailing `/`**. |
| `AgLibraryFile.baseName` / `extension` | Filename **without** path; extension **without** dot (e.g. `CR2`, `jpg`). |

**Case:** Windows paths are case-insensitive on disk; Lightroom generally preserves the casing present at import. No authoritative Adobe spec — **unconfirmed** whether casing is normalized in SQLite.

**Trailing slash:** Treat **`absolutePath`** and non-empty **`pathFromRoot`** as **including** the trailing separator; concatenation must not insert an extra `/` or `\` ([`reader.ts`](https://github.com/ccanalesb/lightroom-tagger/blob/master/apps/visualizer/backend/src/lightroom/reader.ts) comment).

---

## Real Windows values (quoted sources)

**Local root + folder + file (Win10, `--full` output):**

```text
'root_absolute_path': 'C:/Users/human/Pictures/2010/'
'root_rel_path_from_catalog': '../2010/'
'folder_path_from_root': '2010-05-04/'
'file_base_name': '20100504-IMG_7360'
'file_extension': 'CR2'
```

→ Full path: `C:/Users/human/Pictures/2010/2010-05-04/20100504-IMG_7360.CR2`

Source: [LightroomClassicCatalogReader README](https://github.com/thatlarrypearson/LightroomClassicCatalogReader/blob/master/README.md) (Windows 10 author; notes LR stores `/` not `\`).

**SQL path join (community tools, no OS normalization):**

```sql
rf.absolutePath || fo.pathFromRoot || fi.baseName || "." || fi.extension
```

Source: [fdenivac/Lightroom-SQL-tools `lrcat.py`](https://github.com/fdenivac/Lightroom-SQL-tools/blob/master/lrtools/lrcat.py).

---

## Catalog moved between macOS and Windows

Lightroom does **not** maintain parallel path columns per OS. The same SQLite rows travel with the `.lrcat`; resolution depends on **`relativePathFromCatalog`** when valid, else **`absolutePath`**.

| Situation | Typical behavior |
|-----------|------------------|
| Catalog + originals on **same exFAT/external** tree; images under catalog folder | **`relativePathFromCatalog`** resolves on both OSes; **`absolutePath`** may be rewritten when opened on each OS ([Lightroom Queen — portable package](https://www.lightroomqueen.com/community/threads/lr-cc-in-windows-sharing-with-mac.37862/)). |
| Catalog on C:, photos on **other drive letter** | **`relativePathFromCatalog`** often **NULL**; only **`C:/…` or `D:/…` absolutePath** works on Windows; macOS sees missing folders until relink ([Lightroom Queen](https://www.lightroomqueen.com/community/threads/semi-ot-question-re-file-path-on-windows.43010/)). |
| **UNC** roots from Windows | macOS **Update Folder Location** may fail with **“Invalid path”** for `\\…` roots ([Bill Lee](https://billlee.photography/fixing-lightroom-catalogs-migrated-from-windows-to-mac/), [Reddit](https://www.reddit.com/r/Lightroom/comments/1p30gnx/lightroom_classic_invalid_path_error_when_moving/)). Workaround: close LR, backup `.lrcat`, **`UPDATE AgLibraryRootFolder SET absolutePath = '…'`** to a macOS path (e.g. `/Volumes/Photos/Party pics/`), then **Find Missing Folder** in UI. |
| macOS catalog with **`//NAS/…`** opened on Windows | Paths won’t match Windows mounts (`Z:/`, `\\NAS\…`); user must relink or edit `absolutePath`. This repo’s **`resolveFilepath`** only helps **`//…`** when **`NAS_*` env** or **`/Volumes`** scan applies — **not** on Windows. |
| Switching OS repeatedly | Drive letters vs volume names cause **missing files** until folder-level relink; Adobe recommends **folder** relink not per-file ([Adobe Community](https://community.adobe.com/questions-675/lightroom-classic-catalog-on-external-ssd-from-macos-to-windows-10-unable-to-find-missing-images-956358)). |

Adobe SDK: `catalog:findPhotoByPath(path)` and `catalog:getFolderByPath(path)` take a **single absolute path string**; they do not document SQLite storage format ([LrCatalog SDK mirror](https://github.com/micdah/LrControl/blob/master/Docs/Lightroom%20SDK%206.0/API%20Reference/modules/LrCatalog.html)).

---

## How this repo builds paths today

### `reader.ts`

```225:227:apps/visualizer/backend/src/lightroom/reader.ts
    // Concatenated without a separator, because Lightroom stores both halves with
    // their trailing slash already on.
    filepath: rootPath + folderPath + (extension ? `${filename}.${extension}` : filename),
```

No separator normalization, no `path.join`, no drive/UNC detection.

### `path-resolve.ts`

- **`resolveFilepath`:** If the path does **not** start with **`//`**, return unchanged. Otherwise map `//server/share/rest` via **`NAS_PATH_PREFIX` / `NAS_MOUNT_POINT`** or macOS **`/Volumes`** scan.
- **`resolveCatalogPath`:** `existsSync(filepath)` first; else try **`resolveFilepath`** and accept only if the result exists.

### What `reader.ts` + `resolveFilepath` produce for Windows-shaped rows

| Stored `filepath` (after reader concat) | `resolveFilepath` output | Notes |
|----------------------------------------|---------------------------|--------|
| `C:/Users/me/Pictures/2024/01/IMG_001.jpg` | Same string | Node on Windows generally opens `C:/…`; passthrough is correct if files exist at that path. |
| `Z:/Photos/2024/01/IMG_001.jpg` | Same string | Mapped drive; no UNC rewrite. |
| `\\NAS\Photos\2024\IMG_001.jpg` | Same string | On Windows, `existsSync` may succeed if share is reachable; **no** `NAS_*` mapping. On macOS/Linux, likely **missing** unless a odd mount matches literally. |
| `//10.88.111.157/ccanales/…/IMG_001.jpg` | Mapped or original `//…` | macOS NAS case; **`resolveFilepath`** may rewrite under `/Volumes` or env. On **Windows**, `//` prefix triggers the **macOS-oriented** branch — **likely wrong** unless env is tuned; **unconfirmed** whether Windows LR ever stores NAS roots as `//…`. |

---

## Adobe / schema references

- Default Windows catalog location: `C:\Users\[user]\Pictures\Lightroom\` ([Catalog FAQ](https://helpx.adobe.com/lightroom-classic/kb/catalog-faq-lightroom.html)).
- `.lrcat` is SQLite; folder tables documented in community reverse-engineering ([lrcat_format.md](https://github.com/hfiguiere/lrcat-extractor/blob/main/doc/lrcat_format.md)).
- Catalog **cannot** live on a network share (photos can) ([Catalog FAQ — network](https://helpx.adobe.com/lightroom-classic/kb/catalog-faq-lightroom.html)).

---

## Unconfirmed (needs a Windows `.lrcat` corpus in this project)

1. Exact **`absolutePath`** string for **UNC** roots in current Lightroom Classic ( **`\\server\share\`** vs **`//server/share/`** ).
2. **`relativePathFromCatalog`** for mapped-drive roots when catalog and “drive” are considered same volume.
3. Whether **very old** Windows catalogs ever stored **backslashes** in `absolutePath` / `pathFromRoot` before Adobe’s slash normalization.
4. **`//`-prefixed paths on Windows** catalogs (if any) interacting with this repo’s **`resolveFilepath`**.
5. **Case** normalization in SQLite vs on-disk NTFS.

---

## Related

- Prior audit: [posix-assumptions-audit.md](https://github.com/ccanalesb/lightroom-tagger/blob/origin/research/posix-assumptions/docs/research/posix-assumptions-audit.md) on branch `research/posix-assumptions`.
- Implementation tracking: [#391](https://github.com/ccanalesb/lightroom-tagger/issues/391).

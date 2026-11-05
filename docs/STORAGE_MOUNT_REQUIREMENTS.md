# Storage and mount requirements

The visualizer backend runs on a **host machine** (your server, VM, or dev box). Lightroom catalogs and image files often live on a NAS or network share.

**The share is required to build the vision cache, and only then.** Compressing an original into a cached JPEG is the one operation that must read the original bytes off disk. Description, scoring and embedding are cache-first: they look for the cached JPEG before touching the original, and fall back to it when the original is unreachable. An image that has been cached once can be described, scored and embedded forever after with the share offline.

So an unmounted share does not stop these jobs — it caps them. They process whatever the cache already covers, skip the rest image by image, and complete with a grouped skip summary saying why. What you lose is the ability to bring *new* images into the cache.

If the share is mounted at the wrong path, the same thing happens silently: paths do not resolve, nothing new gets cached, and jobs process only what was cached earlier.

## How paths are resolved

The library database stores file paths as Lightroom recorded them—often UNC-style network paths:

```
//tnas/ccanales/Photos/2024/IMG_1234.jpg
```

At runtime, `resolveCatalogImageFilePath()` in `apps/visualizer/backend/src/utils/path-resolve.ts` maps UNC paths to a **local mount point** on the backend host:

| Platform | Typical mount |
|----------|----------------|
| macOS (SMB) | `/Volumes/<share>/...` (auto-detected under `/Volumes/`) |
| Linux / WSL | `/mnt/nas/...`, `/mnt/tnas/...`, or your configured path |

Example:

```
//tnas/ccanales/Photos/2024/IMG_1234.jpg  →  /Volumes/ccanales/Photos/2024/IMG_1234.jpg
```

The resolved path must exist and be readable (`os.path.isfile`) before an image can be **cached for the first time**. After that, the cached JPEG is what the vision jobs read.

> **Reading the output of `resolve_filepath()`:** when no mapping matches *and* when the mapped file is not found on disk, the function returns the original UNC path unchanged. A returned `//...` path therefore means "could not produce a usable local path" — it does **not** distinguish a missing mount mapping from a file that has been deleted or moved since the catalog was read. Check the mapped location by hand before concluding the mount is misconfigured.

### Configuration

Set the mount point in `config.yaml` or via environment variable:

```yaml
mount_point: "/mnt/nas"   # or /Volumes/ccanales on macOS
```

```bash
export LIGHTRoom_MOUNT=/mnt/nas
```

When the visualizer backend starts, it copies `mount_point` into `NAS_MOUNT_POINT` and may auto-detect `NAS_PATH_PREFIX` from a sample UNC path in `library.db`.

You can also set these explicitly:

```bash
export NAS_PATH_PREFIX=//tnas/ccanales
export NAS_MOUNT_POINT=/mnt/tnas
```

See also [Catalog read vs write](CATALOG_READ_WRITE.md) for how the backend opens `.lrcat` files on network storage.

## Symptoms

| What you see | Likely cause |
|--------------|--------------|
| Embed (or cache build) **finishes quickly** with `embedded: 0` and high `skipped` | Most file paths do not resolve to readable files |
| Job Queue shows **Embed diagnostics** with large counts for **Missing file** or **Empty path** | UNC paths not mapped to an existing mount |
| Job log warns *"sampled paths unreachable — this usually means your network share is not mounted"*, then keeps going | Preflight sampled images and found inaccessible paths; the job continues on cached images |
| Description or scoring jobs process a small fraction and skip the rest | Only the already-cached images could be served; the rest need the original |

Path-dependent jobs run a **preflight check** on a random sample of pending images and log what they find. The preflight is **advisory**: it never fails the job. Unreachable images are skipped individually and reported in the job's grouped `skip_reason_counts`, so a run made while the share is down completes honestly rather than aborting and discarding the work it could have done. (Before this was changed, a sample with more than half its paths inaccessible aborted the whole job — including the cached images it would have processed fine.)

## Fix steps

### 1. Verify the mount on the backend host

SSH or log in to the machine running the visualizer backend (not your Lightroom workstation unless they are the same).

```bash
# Linux — is the share mounted?
mount | grep -E 'nas|tnas|cifs|smb'

# macOS — is the volume present?
ls /Volumes/

# Can you read a known file?
test -r /mnt/nas/Photos/some-known-file.jpg && echo OK || echo MISSING
```

If the mount is missing, mount the share before retrying jobs. On Linux this is often `/etc/fstab` or a manual `mount -t cifs ...`; on macOS, connect the share in Finder so it appears under `/Volumes/`.

### 2. Check path resolution

Pick a UNC path from your library (Processing → Catalog cache shows cache location; or query `images.filepath` in `library.db`):

```bash
cd apps/visualizer/backend && npx tsx -e "
import { resolveCatalogImageFilePath } from './src/utils/path-resolve.ts';
const p = '//tnas/ccanales/Photos/example.jpg';  // replace with a real path
console.log('resolved:', JSON.stringify(resolveCatalogImageFilePath(p)));
"
```

The resolver only returns a path it has confirmed exists, so the output is binary:

- An empty string means unreachable. Either no mount mapping matched (set `mount_point` / `NAS_MOUNT_POINT`) **or** the mapping worked but the file is not there. Map the path by hand and test it before assuming the mount is at fault—if the hand-mapped file exists, the mount is fine and the resolver simply could not confirm it.
- A local path means resolution and the mount are both working for that file.
- A catalog that has outlived some of its files will always have a residue of paths that resolve nowhere. Those images can never be cached, and no mount fixes them.

Restart the visualizer backend after changing `config.yaml` or mount env vars so `NAS_MOUNT_POINT` is picked up.

### 3. Retry the job

1. Open **Processing → Catalog cache**.
2. Re-run **Embed catalog images** (or the full cache build).
3. Open **Job Queue** and confirm `embedded` counts increase and skip diagnostics shrink.

If images are still skipped, read the job's skip diagnostics for the breakdown (`Missing file`, `Empty path`, `No DB row`).

## Jobs affected

Requires the share (reads original image bytes):

- Catalog cache build
- Prepare catalog (pre-compress)
- Embed catalog images, for any image not yet cached

Runs without the share, for images already in the vision cache:

- Description and scoring pipelines
- Embed catalog images, for cached images

The catalog SQLite file itself also must be readable on the backend; see the NAS section in the main [README](../README.md#catalog-on-network-storage-nassmb).

# ADR-0019: The backend is always local; only the UI travels

**Status:** Accepted (2026-09-18)
**Date:** 2026-09-18

The desktop shell is Tauri ([ADR-0022](0022-desktop-app-is-tauri-with-a-node-sidecar.md));
where this ADR says Electron, read the desktop shell.

## Context

The product goal is a standalone application other photographers install, with
the option to reach its UI from another device. That reads like "make the
backend deployable," and it isn't — the backend cannot leave the machine holding
the photos.

Measured against the working library:

| Artifact | Size |
|---|---|
| `FinalCatalog-v13-3.lrcat` | 2.8 GB |
| `library.db` | 609 MB |
| vision cache | 4.0 GB across 43,813 files |

All 43,794 image rows point at `//10.88.111.157/ccanales/Lightroom Server/...`,
a UNC path on a LAN-only NAS. `catalog_cache_build` chains four stages — sync,
embed, stack, similarity — and three of them read pixels rather than metadata.
Rebuilding the cache means decoding 43,794 DNGs off that NAS, compressing each
to a 50–135 KB JPEG, computing a phash, and running CLIP over the result. That
work needs the photos, local CPU, and the Ollama host at `localhost:11434`.

So a remote backend fed only the catalog would hold metadata for 43,794 images
it can never open, and could not build the cache that would let it serve them.
No transport fixes this: the catalog carries no pixels.

## Decision

The backend and the CLI run on the machine that holds the catalog and can reach
the photos. The SPA may be served to other devices, but the API it talks to is
always the local one.

Operations that need the catalog file, the originals, or local compute are
**local-only operations** — catalog selection, catalog sync, and cache builds.
A remote client browses what has already been built and must degrade visibly
rather than offer a control that cannot work.

The catalog path stays a plain string. Everything considered here concerned how
that string is *acquired*, not how it is represented, so no catalog value
object, branded type or selector union is introduced.

## Consequences

- **"Deployable" means packaging, not hosting.** The distribution problem is an
  installable desktop app ([#328](https://github.com/ccanalesb/lightroom-tagger/issues/328)),
  not a server tier. A hosted service would need a local agent feeding it
  anyway, at which point it is the same architecture with a network in the
  middle.
- **Remote access is a UI affordance and needs authentication.** There is none
  today: the only `/api/*` middleware is CORS, and `HOST_DEFAULT` is `localhost`
  precisely because nothing guards the API. Serving the UI off-machine as a
  shipped feature requires auth first. Accepted as-is while this stays a
  single-user tool on a trusted network.
- **Catalog selection can use machine-local mechanisms.** Since the backend is
  co-located with the user for every local-only operation, it may open a native
  dialog on its own screen. `POST /api/config/catalog/pick` does exactly that,
  via `osascript`, and is macOS-only; typing a path stays as the fallback for
  every other host and for a UI reached from another device.
- **The client has to judge co-location itself, and only loopback proves it.**
  `picker_available` answers whether the backend's OS has a dialog, not whether
  anyone is in front of it, so a phone talking to a Mac would still be offered
  the button and would hold the request open until it timed out. The frontend
  therefore shows the control only when it was served over loopback. Reaching
  the UI by LAN address while sitting at that machine reads as remote and gives
  up the dialog — the cheaper of the two errors, and one Electron removes.
- **Any future "access from anywhere" work starts from pushing derived
  artifacts** — `library.db` plus the vision cache, roughly 4.6 GB — from a
  local agent to a read-mostly service. Not from moving the backend.

## Alternatives considered

Each was killed by a specific fact, recorded here so they are not re-proposed.

- **Upload the `.lrcat` to a remote backend** — rejected. 2.8 GB per sync for a
  file that changes on every Lightroom edit, and the server still cannot see the
  photos or build the cache. It is the derived-artifact architecture with a
  worse transport.
- **A backend-rendered directory browser**, the self-hosted default (Sonarr,
  Jellyfin, Plex, Syncthing, Audiobookshelf all ship one) — rejected. It is the
  first HTTP endpoint that enumerates the host filesystem, on an API with no
  auth. The advisory history for that endpoint class is almost entirely
  `startsWith` prefix-check bypasses; `isPathUnderAllowedRoots` already does
  containment correctly with `realpath` plus `root + sep`, and would be the
  thing to extend if this is ever revisited.
- **A native dialog spawned by the backend via `osascript`** — adopted, after
  first being rejected for assuming the backend shares a GUI session with the
  user. It does assume that, but the assumption is the one this ADR already
  makes everywhere else, and a text field people have to feed by hand is not a
  picker. The endpoint is a thin wrapper that an Electron shell deletes.
- **Discovering catalogs heuristically**, by scanning known Lightroom locations
  or reading `recentLibraries20` out of Lightroom's preference plist — rejected.
  A `~/Pictures` scan finds only the empty default `Lightroom Catalog.lrcat` and
  misses the real catalog under `~/lightroom/`; the plist keys are version-coupled
  (`com.adobe.LightroomClassicCC7`, the `20` suffixes) and hold Lua-ish
  serialized text needing its own parser.
- **Getting the path from the browser** — impossible, not merely rejected.
  `File.path` was never a web API (it was Electron's, removed in Electron 32),
  the File System Access API deliberately exposes only opaque handles, and all
  three engines blank `text/uri-list` for `file:` scheme drags. Finder's
  "Copy as Pathname" is the exception, because it puts plain text rather than a
  file on the pasteboard, and is what the fallback field leans on.

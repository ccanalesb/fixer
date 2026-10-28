# Release runbook

This document describes how to cut a Fixer desktop release. CI builds unsigned installers for macOS arm64, Windows x64, and Linux x64 when a version tag is pushed.

## Before the first public release (`v0.1.0`)

Do not publish a non-prerelease until all of the following are done:

1. **Rename the GitHub repository** to `ccanalesb/fixer`. The in-app updater endpoint is baked into every shipped binary and must use the final repository name.
2. **Back up the updater signing key** in a password manager: the private key file `~/.tauri/fixer-updater.key` on the owner's Mac and its password (macOS Keychain item `fixer-updater-key-password`). Its public key is `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json`; the private key and password are the GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Losing the key strands every installed copy on manual reinstall: a new key means a new public key, which existing installs do not trust.
3. **Ship the providers work** described in [Add and remove any HTTP-reachable OpenAI-compatible provider from the Providers tab](https://github.com/ccanalesb/lightroom-tagger/issues/332) (the providers PRD). Until then, keep releases as drafts or `-beta.N` prereleases only.

## Version and tag

1. Bump the single app version in the root `package.json`. Backend and frontend package versions stay at `0.0.0`.
2. Commit the bump on the release branch.
3. Create and push an annotated tag whose name matches the version, with a `v` prefix (for example version `0.1.0-beta.1` → tag `v0.1.0-beta.1`).
4. CI fails the release workflow’s first job if the tag (without `v`) does not exactly match `package.json`.

Prerelease tags matching `vX.Y.Z-beta.N` are published as GitHub **prereleases**. The updater never offers them because `releases/latest` skips prereleases.

## What CI does

On tag push:

1. Re-runs the PR gate (OpenAPI drift, typechecks, frontend and backend tests).
2. Builds on `macos-latest`, `windows-latest`, and `ubuntu-22.04`: backend tests on that OS, pinned Node and `uv`, staged backend prune, addon smoke, Tauri build, packaged host smoke (loopback `/api/health`, then quit with no sidecar left behind).
3. Uploads platform bundles to a **draft** GitHub release via `tauri-action` (DMG or `.app` on macOS, NSIS `setup.exe` on Windows, `.deb` on Linux). Updater artifacts are produced only when the signing key secret is configured.

If any matrix leg fails, the draft release may be incomplete; do not publish until all legs are green.

## Manual QA before publishing (macOS)

Perform this on a Mac (Apple Silicon, macOS 14+) using the draft release’s macOS artifact:

1. Install from the DMG (or unzip the `.app` if CI fell back to a zip).
2. Launch Fixer. Confirm the loading page reaches the SPA in **WKWebView** (not only Safari).
3. Walk through **first run**: empty library setup, native catalog picker, catalog import (CLIP confirm if shown).
4. Exercise Settings → About (version, licenses link, Adobe attribution).
5. Quit the app and confirm no stray `node` or `uv` processes remain (`Activity Monitor` or `ps`).

WebView2 (Windows) and WebKitGTK (Linux) rendering are **not** part of this checklist; that is an accepted risk for v1.

## Publish the draft

1. Open the draft release on GitHub when all workflow legs succeeded.
2. Skim the generated release notes.
3. Click **Publish release** (not required for prereleases you intend to keep internal-only).

## Windows: Smart App Control

Fixer v1 is **unsigned**. On Windows 11, **Smart App Control** may block the NSIS installer or the app because it is not signed with a recognized certificate.

Tell users: if Smart App Control blocks Fixer, they can turn Smart App Control off under **Windows Security → App & browser control → Smart App Control**, or wait until a signed build is available. Only install builds from this project’s official GitHub Releases page.

## Cutting a `-beta.N` test build

Use the same tag flow with a `-beta.N` suffix on both `package.json` and the tag. CI produces a prerelease draft suitable for owner testing on a fork or the main repo without advertising `latest`.

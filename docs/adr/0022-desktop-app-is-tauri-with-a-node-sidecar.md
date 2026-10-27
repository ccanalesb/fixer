# ADR-0022: The desktop app is a Tauri shell with the backend as a Node sidecar

**Status:** Accepted (2026-10-26)
**Date:** 2026-10-26

## Context

The installable app wraps the local tier of ADR-0019: the Hono backend, its
job workers and the SPA it serves. The backend is Node and loads native addons
(`sharp`, `better-sqlite3` + `sqlite-vec`, `onnxruntime-node`), so any shell
ships a Node runtime and the same `node_modules` tree beside the UI.

Two shells passed the same packaged smoke on macOS arm64, Windows x64 and
Linux x64 — the real backend starts, the three addons load and run, socket.io
connects from the window:

- **Electron 45**, backend as an `ELECTRON_RUN_AS_NODE` child of the Electron
  binary.
- **Tauri 2**, backend as a sidecar on a stock Node 24 binary, the window a
  system webview (WKWebView, WebView2, WebKitGTK).

Backend `node_modules` dominates the package either way. What the shell itself
adds, unpacked:

| | macOS arm64 | Windows x64 | Linux x64 |
|---|---|---|---|
| Electron 45 runtime | 258 MB | 357 MB | 274 MB |
| Node 24 binary + Tauri binary | ~125 MB | ~98 MB | ~130 MB |

## Decision

The desktop app is **Tauri 2**. The backend runs as a sidecar on a Node 24
binary from nodejs.org, shipped per target triple; the backend's `dist/` and
production `node_modules` ship as bundle resources. The window loads the SPA
from the backend's loopback origin, the same shape as in development; a local
browser is supported from a source install, not from the packaged app.

Two reasons:

- **Size.** About 130 MB less installed on macOS, 260 MB on Windows and 145 MB
  on Linux, on packages of 0.8–1.1 GB.
- **The backend's Node is not the shell's.** The packaged backend runs the
  same Node as development, with stock prebuilt addons, and Node and the shell
  upgrade independently.

Speed was not a reason and was not measured: the backend, which is where the
time goes, runs on Node under either shell.

## Consequences

- **Loopback, not auth.** The packaged backend binds `127.0.0.1`, never
  `0.0.0.0`, and rejects requests whose `Host` is not its own loopback
  address and state-changing requests whose `Origin` is not its own.
- **Rust enters the repo and CI** — a thin host for the sidecar, the native
  dialog and single-instance, plus the Rust toolchain and WebKitGTK build
  dependencies on Linux.
- **The SPA has to work in WebKit.** macOS and Linux render it in WebKit,
  Windows in Chromium (WebView2). Safari-class WebKit is a supported target.
- **Node is a runtime this project patches itself.** Its security releases are
  tracked and shipped independently of Tauri's.
- **One more unsigned executable on Windows** — `node.exe` beside the app —
  for SmartScreen and Smart App Control to judge.
- **Updates are verified with minisign, not with Apple or Authenticode
  signatures.** That may allow in-app updates on an unsigned macOS app; it is
  unverified and not a reason for this decision.

## Alternatives considered

- **Electron 45 with an `ELECTRON_RUN_AS_NODE` child** — proven on all three
  targets, one language, one Chromium for every OS. Rejected for the larger
  package and for binding the backend's Node version to Electron's.

# Storing provider API keys for a Tauri 2 app with a Node sidecar

Research date: **2026-10-26**. Context: packaged desktop shell (Tauri 2) + **Node 24 `externalBin` sidecar** (Hono API + SPA on loopback), three desktop targets (macOS arm64, Windows x64, Linux x64). **No product decision here** — facts, trade-offs, and patterns for where a UI-entered provider key can live and how it reaches the backend.

---

## TL;DR

- **Today in this repo:** the backend resolves credentials only via `api_key_env` / inline `api_key` in `providers.json`; dev loads `.env` with `node --env-file-if-exists=.env` ([`scripts/dev-up.sh`](../../scripts/dev-up.sh), [`registry.ts`](../../apps/visualizer/backend/src/providers/registry.ts)). A Dock/Start-menu launch does not get shell `.env`.
- **Rust OS stores:** the maintained [`keyring`](https://crates.io/crates/keyring) crate (v4.x, **MIT OR Apache-2.0**, default backends: macOS Keychain, Windows Credential Manager, Linux Secret Service via `zbus-secret-service-keyring-store`) ([`keyring` `Cargo.toml`](https://github.com/open-source-cooperative/keyring-rs/blob/master/Cargo.toml)). There is **no first-party Tauri 2 keychain plugin** in [`tauri-apps/plugins-workspace`](https://github.com/tauri-apps/plugins-workspace); community plugins exist (e.g. [`lindongchen/tauri-plugin-keychain`](https://github.com/lindongchen/tauri-plugin-keychain)) but are outside Tauri’s official set.
- **Node OS stores:** [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring) (MIT, prebuilt NAPI binaries for darwin/linux/windows triples in [`package.json`](https://github.com/Brooooooklyn/keyring-node/blob/main/package.json)) wraps the same Rust ecosystem. [`node-keytar`](https://github.com/atom/node-keytar) is **archived** (last push 2022-12-12 per GitHub API).
- **Tauri Stronghold** ([plugin docs](https://v2.tauri.app/plugin/stronghold/)) is an **encrypted on-disk vault** (IOTA Stronghold + Argon2 salt file), **not** the OS keychain; supported on desktop platforms per plugin metadata ([`Cargo.toml`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/stronghold/Cargo.toml)).
- **macOS ad-hoc signing:** Apple documents that **reinstalling a new build signed with the same stable identity** avoids re-prompting Keychain/parental-controls-style checks ([Code Signing Guide — Benefits](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Introduction/Introduction.html)). **Ad-hoc** signing (`signingIdentity: "-"` per [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)) does **not** provide that stable identity; Electron’s `safeStorage` docs state that without a **valid, consistent signature**, macOS may treat each build as a different app and **Keychain may re-prompt on every update** ([`safe-storage.md`](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)). Separate **Tauri host** vs **Node sidecar** executables are **different binaries** with **different designated requirements** even inside one bundle — expect **separate Keychain ACLs** unless one process alone owns keychain I/O (pattern used by Jan; see §5).
- **Linux without Secret Service:** `@napi-rs/keyring` tries Secret Service first, then **silently falls back to kernel keyutils** ([README](https://github.com/Brooooooklyn/keyring-node/blob/main/README.md)); keyutils is **in-memory**, **not persistent across reboot** ([`linux-keyutils-keyring-store` source comments](https://github.com/open-source-cooperative/linux-keyutils-keyring-store/blob/main/src/lib.rs)). Electron/Chromium `basic_text` uses a **hardcoded password** when no store exists ([`safe-storage.md`](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)). VS Code encrypts into app storage when `safeStorage`/`encryption` is available, else **in-memory only** ([`secrets.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/secrets/common/secrets.ts), [`encryptionMainService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/encryption/electron-main/encryptionMainService.ts)).
- **Windows Credential Manager** entries are per **TargetName + type + user logon session**, not bound to the signing hash of the installer ([`CredWrite`](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritea)). Replacing an unsigned NSIS-installed app **does not inherently invalidate** stored credentials (contrast with macOS ad-hoc Keychain behavior).
- **Handing secrets to the sidecar:** `tauri-plugin-shell` supports `.env()` / `.envs()` on spawn ([`process/mod.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)); Linux exposes spawn-time env via `/proc/<pid>/environ` to callers passing **ptrace read** checks ([`proc_pid_environ(5)`](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html)). **Hot key rotation without restart** favors **sidecar reading the store/file per request** or **runtime `process.env` / in-memory override**, not env-only-at-spawn.
- **`make dev` / browser-only:** `.env` + `api_key_env` works without Tauri; OS keyring from **Node (`@napi-rs/keyring`) or Rust CLI** also works; Stronghold/Tauri invoke paths **require the host**.

---

## 1. Current backend behavior (this repo)

| Mechanism | Behavior | Source |
|-----------|----------|--------|
| `api_key_env` | `resolveApiKey` returns `process.env[name] ?? ''` | [`registry.ts`](../../apps/visualizer/backend/src/providers/registry.ts) |
| `api_key` inline | Used directly (e.g. Ollama placeholder) | same |
| Availability | `isAvailable` is true if inline key set or env var non-empty | same |
| Dev load | `exec node --env-file-if-exists=.env --import tsx src/server.ts` | [`scripts/dev-up.sh`](../../scripts/dev-up.sh) |
| Node flag | `--env-file` loads into `process.env` at startup; not applied to `--run` subprocesses | [Node CLI `--env-file`](https://nodejs.org/api/cli.html#--env-fileconfig) |

`ProviderRegistry` is constructed per request in some paths, but **`process.env` is process-wide** — updating a key at runtime requires mutating `process.env` or bypassing env for that lookup.

---

## 2. OS secret stores and library map

### 2.1 What “the OS store” means per platform

| Platform | Native API | Typical user-visible name |
|----------|------------|---------------------------|
| macOS | Keychain Services (generic password items) | Keychain Access |
| Windows | Credential Manager (`CredWrite` / `CredRead`) | Credential Manager / Windows Credentials |
| Linux | freedesktop **Secret Service** (D-Bus) | GNOME Keyring, KWallet, KeePassXC (service), etc. |

Secret Service scope is defined in the [Secret Service API draft](https://specifications.freedesktop.org/secret-service/latest/).

### 2.2 Rust: `keyring` crate ecosystem

| Item | Detail | Source |
|------|--------|--------|
| Maintenance | `keyring` **4.2.0**, `rust-version = 1.88`, cooperative org [`open-source-cooperative/keyring-rs`](https://github.com/open-source-cooperative/keyring-rs) | [`Cargo.toml`](https://github.com/open-source-cooperative/keyring-rs/blob/master/Cargo.toml) |
| License | **MIT OR Apache-2.0** | [`README`](https://github.com/open-source-cooperative/keyring-rs/blob/master/README.md) |
| Default backends (feature `v1`) | `apple-native-keyring-store/keychain`, `windows-native-keyring-store`, `zbus-secret-service-keyring-store` | [`Cargo.toml`](https://github.com/open-source-cooperative/keyring-rs/blob/master/Cargo.toml) |
| macOS implementation | Generic passwords via `security-framework` (`set_generic_password` / `find_generic_password`) | [`keychain.rs`](https://github.com/open-source-cooperative/apple-native-keyring-store/blob/main/src/keychain.rs) |
| API surface | `Entry::new(service, user)` → `set_password` / `get_password` / `delete_credential` | [`examples/v1/main.rs`](https://github.com/open-source-cooperative/keyring-rs/blob/master/examples/v1/main.rs) |
| Tauri sample | Cross-platform Keyring GUI for **Tauri 2** (CrabNebula builds) | [`keyring-demo`](https://github.com/open-source-cooperative/keyring-demo) |

**Native cost in Rust host:** pure Rust + OS frameworks (Security.framework, Advapi32, D-Bus/zbus on Linux) — **no Node-style prebuilt matrix**, but adds Rust deps and Linux D-Bus/Secret Service runtime expectations.

### 2.3 Node: `@napi-rs/keyring` vs `keytar`

| Library | Status | Native addon | License | Linux without Secret Service |
|---------|--------|--------------|---------|------------------------------|
| **`@napi-rs/keyring`** | Active (npm **2.1.2**, Oct 2026) | Prebuilt `@napi-rs/keyring-*` per platform triple ([`package.json` `napi.targets`](https://github.com/Brooooooklyn/keyring-node/blob/main/package.json)) | **MIT** | Auto: Secret Service → **keyutils** fallback ([README](https://github.com/Brooooooklyn/keyring-node/blob/main/README.md)) |
| **`keytar` (`node-keytar`)** | **Archived** on GitHub | node-gyp era | MIT (historical) | Same class of backends when maintained |

**Sidecar packaging impact:** bundling a stock Node sidecar **plus** `@napi-rs/keyring` means shipping **platform-specific `.node` binaries** (or running `napi rebuild` in CI). Linux `.node` **statically links vendored `libdbus`** (license **AFL-2.1 OR GPL-2.0-or-later** noted in npm README).

**Compatibility shim:** package ships `keytar.js` re-export ([`package.json` `files`](https://github.com/Brooooooklyn/keyring-node/blob/main/package.json)) for migrations off keytar.

### 2.4 Tauri 2 plugins (official)

| Plugin | Role for secrets | OS keychain? |
|--------|------------------|--------------|
| **`tauri-plugin-stronghold`** | Password-derived Stronghold vault; records in `vault.hold` under app data ([docs example](https://v2.tauri.app/plugin/stronghold/)) | **No** — local encrypted file |
| **`tauri-plugin-store`** | JSON key-value file ([docs](https://v2.tauri.app/plugin/store/)) | **No** — plaintext JSON unless app encrypts |
| **Shell / sidecar** | Spawn control, `.env()` injection ([§4](#4-handing-the-key-to-the-node-sidecar)) | N/A |

No **`tauri-plugin-keyring`** in the official plugins workspace (GitHub code search count **0** for `keyring` in `tauri-apps/plugins-workspace`).

---

## 3. macOS: ad-hoc signing, updates, and two binaries (host + sidecar)

### 3.1 Stable signing vs ad-hoc

Apple’s Code Signing Guide states that after installing a **new version** signed such that the system treats it as the **same program** (stable identity / designated requirement), the user is **not** bothered again for Keychain-style permission ([Introduction — Benefits](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Introduction/Introduction.html)).

Tauri documents **ad-hoc** signing via `"signingIdentity": "-"` ([macOS Code Signing — Ad-Hoc Signing](https://v2.tauri.app/distribute/sign/macos/)). Ad-hoc signatures are **not** a stable Developer ID / MAS identity.

Electron documents the user-visible consequence explicitly: on macOS, **`safeStorage` requires code signing** for consistent behavior; **without a valid, consistent signature**, Keychain may **re-prompt on every update** ([`safe-storage.md` — IMPORTANT note](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)). The same constraint applies to **any** Keychain-backed storage using default ACLs tied to the signing identity.

**Operational expectation for this product (ad-hoc, not notarized, replace-on-update):**

- Items **created** by build *N* may trigger **access or ownership dialogs** when read by build *N+1* (new CDHash / designated requirement). “Always Allow” for ad-hoc builds **may not persist** across updates (widely reported; treat as **high risk** — primary Apple/Electron sources above cover the mechanism; per-build prompt frequency for this exact bundle layout is **UNVERIFIED** without a local experiment).
- `apple-native-keyring-store` maps `errSecInvalidOwnerEdit` to `NoStorageAccess` ([`decode_error` in `keychain.rs`](https://github.com/open-source-cooperative/apple-native-keyring-store/blob/main/src/keychain.rs)) — updates can surface as **hard failures** unless the item is re-created under the new binary.

### 3.2 Tauri host vs Node sidecar as Keychain clients

The macOS Keychain store binds generic passwords to the **application that created the item** via access controls (see Apple Code Signing Guide — **designated requirement** discussion in [Requirement Language](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html)).

The sidecar is a **separate executable** (`externalBin` sibling, [Tauri sidecar docs](https://v2.tauri.app/develop/sidecar/)). **UNVERIFIED:** whether your bundler applies one signature narrative to both; even then, **two Mach-O executables normally have distinct CDHashes**. Practical pattern from **Jan**: persist secrets from **one Rust component** in the keyring; CLI reads the same service name ([`provider_secrets.rs`](https://github.com/janhq/jan/blob/main/src-tauri/src/core/server/provider_secrets.rs)) — avoids splitting ACLs across unrelated binaries.

**Implication:** “Rust writes, Node reads” or the reverse via OS keychain **may require duplicate prompts or re-storing keys** unless only **one** of the two processes ever touches Keychain.

---

## 4. Windows: unsigned / NSIS updates

Windows Credential Manager stores credentials associated with the **user’s logon session** ([`CredWrite`](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritea)). There is **no documented coupling** to the Authenticode hash of the replacing installer.

**Expectation:** updating an unsigned NSIS build **should retain** credentials written under the same `service`/`account` naming convention, subject to normal TargetName rules (same user, same target name).

DPAPI-protected blobs (Electron `safeStorage` on Windows) are scoped to **the same logon credential** ([`safe-storage.md`](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)), also **not** to a specific EXE hash.

---

## 5. Linux: no Secret Service

| Client | When Secret Service absent | Persistence |
|--------|----------------------------|-------------|
| **`@napi-rs/keyring`** | Silent fallback to **keyutils** ([README](https://github.com/Brooooooklyn/keyring-node/blob/main/README.md)) | **Not across reboot** ([keyutils store docs in source](https://github.com/open-source-cooperative/linux-keyutils-keyring-store/blob/main/src/lib.rs)) |
| **`keyring` crate (default zbus SS)** | Fails unless optional keyutils backend configured | SS: persistent collections per spec; keyutils: same as above |
| **Electron `safeStorage`** | `getSelectedStorageBackend()` → **`basic_text`** — encrypts with **hardcoded password** ([`safe-storage.md`](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)) | File-backed ciphertext under user data, weak semantics |
| **VS Code `SecretStorage`** | If `encryptionService.isEncryptionAvailable()` false → **in-memory** store only ([`BaseSecretStorageService.initialize`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/secrets/common/secrets.ts)) | Lost on exit |
| **Jan fallback** | Latch keyring “down” after infra errors; use **`provider_secrets.enc`** AES-256-GCM, **`0600` on Unix** ([`provider_secrets.rs`](https://github.com/janhq/jan/blob/main/src-tauri/src/core/server/provider_secrets.rs)) | Persistent file |

Secret Service itself expects a session D-Bus and an unlocked collection ([spec introduction](https://specifications.freedesktop.org/secret-service/latest/)); minimal/headless desktops often lack it.

---

## 6. App-data file (0600 / ACL) and what peers do

### 6.1 Permissions the app can set

| OS | Mechanism | Notes |
|----|-----------|-------|
| Unix | `chmod 0600` after write | Jan: [`restrict_permissions`](https://github.com/janhq/jan/blob/main/src-tauri/src/core/server/provider_secrets.rs) |
| Windows | DACL on file (user-only) | Not verified in this repo; standard Win32 ACL APIs apply — **UNVERIFIED** for exact Tauri path helpers |

Tauri **`app_local_data_dir`** layout for packaged apps is documented in prior sidecar research ([`path.ts`](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/path.ts)).

### 6.2 Comparable apps (public sources)

| App | UI-entered API keys | Storage pattern | Source |
|-----|---------------------|-----------------|--------|
| **Jan** | Yes | **OS keyring first** (`keyring` crate, service `jan-providers`); **encrypted file fallback** + index file; env/CLI override | [`provider_secrets.rs`](https://github.com/janhq/jan/blob/main/src-tauri/src/core/server/provider_secrets.rs) |
| **VS Code** | Extensions use `SecretStorage` | **Encrypted** `secret://` keys in app storage when OS encryption available; else **in-memory**; Linux backend from Electron (`gnome_libsecret`, `kwallet*`, `basic_text`) | [`secrets.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/secrets/common/secrets.ts), [`encryptionMainService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/encryption/electron-main/encryptionMainService.ts), [`safe-storage.md`](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md) |
| **Open WebUI** | Admin UI config | **SQLite `config` rows** (env migration map); server-side DB, not OS keychain | [`3ff2c63645b8_reshape_config_to_per_key_rows.py`](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/migrations/versions/3ff2c63645b8_reshape_config_to_per_key_rows.py) |
| **LM Studio** | UI for provider keys | **UNVERIFIED** — no public source reviewed for storage implementation | — |
| **Ollama desktop** | N/A for cloud keys | Local inference; not comparable for cloud API key UI | — |

**Jan’s stated threat model for file fallback:** deters casual disk/backup inspection; **not** resistant to attacker with code + disk ([module docs](https://github.com/janhq/jan/blob/main/src-tauri/src/core/server/provider_secrets.rs)).

---

## 7. Handing the key to the Node sidecar

| Channel | Packaged Tauri | Hot reload (UI saves new key) | `make dev` / no Tauri | Security notes |
|---------|----------------|------------------------------|------------------------|----------------|
| **Env at spawn** (`.env()` on sidecar command) | Yes ([`process/mod.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)) | **No** unless sidecar restarted or env mutated in-process | `.env` via `node --env-file-if-exists` | Linux: `/proc/<pid>/environ` readable with ptrace policy ([`proc_pid_environ(5)`](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html)). Windows: per-process env block ([Environment Variables](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables)). Cross-process env inspection on Windows/macOS for same user: **UNVERIFIED** detail level |
| **Stdin / startup IPC** | Custom protocol | Possible if sidecar listens | Same | Secret in pipe buffer lifetime; must define framing/auth |
| **Host HTTP to loopback** | Possible (new authenticated route) | **Yes** if backend applies to `process.env` or memory | Browser can call same API | Must not expose unauthenticated secret endpoints (ADR local-only assumption) |
| **Tauri invoke → Rust → ???** | Yes | Yes if Rust updates store and notifies sidecar | No | Bridges webview to host |
| **Sidecar reads OS store / file itself** | Yes (`@napi-rs/keyring` or file) | **Yes** if read per request or watch file | Yes | macOS: sidecar binary owns Keychain ACL; Linux: SS/keyutils semantics apply |
| **Stronghold in Rust only** | Yes | Requires host reload into sidecar (env/IPC) | No | Vault password handling separate from provider API key |

**Effect without restart (aligns with `registry.ts`):**

- **Env-only:** changing UI cannot affect `process.env` unless sidecar exposes an API that sets env or registry reads elsewhere.
- **Per-request read** from keyring/file: works with current “new registry per request” pattern if `resolveApiKey` is extended to consult that store.
- **In-memory cache + invalidation:** single process, no Keychain round-trip per request.

---

## 8. Source install (`make dev`, browser-only)

| Approach | Works without Tauri? |
|----------|---------------------|
| `providers.json` + `.env` + `api_key_env` | **Yes** ([`dev-up.sh`](../../scripts/dev-up.sh)) |
| `@napi-rs/keyring` in backend | **Yes** (same Node process as server) |
| `keyring` in a Rust CLI helper | **Yes** (external helper invoked by dev scripts) |
| Tauri Stronghold / invoke / sidecar spawn env injection | **No** (needs packaged host) |
| Jan-style encrypted file under user data dir | **Yes** if path matches dev data dir convention |

---

## 9. What this means for the decision

Options fall along three axes: **where the secret bits live**, **which process reads/writes them**, and **how updates behave on ad-hoc macOS**.

1. **Keep env + `.env`, document for power users only**  
   - *Pros:* zero native deps; dev parity today.  
   - *Cons:* GUI users lack keys; secrets on disk in plaintext; Dock launch gap remains.

2. **Node sidecar owns `@napi-rs/keyring` (or encrypted file fallback)**  
   - *Pros:* one Mach-O/CDHash client on macOS; hot reload via per-request read; works in **`make dev`**.  
   - *Cons:* native `.node` per platform in sidecar bundle; Linux SS vs keyutils persistence surprise; macOS ad-hoc still re-prompts on **sidecar binary update**.

3. **Rust host owns `keyring`, inject at spawn via `.env()`**  
   - *Pros:* UI→Rust fits Tauri; webview never holds long-lived key.  
   - *Cons:* rotation requires restart or extra IPC; env visible per §7; **Node may not read Keychain items Rust created** without macOS ACL pain.

4. **Rust host owns `keyring`, Node never touches OS store (HTTP/internal sync)**  
   - *Pros:* single Keychain writer on macOS.  
   - *Cons:* design authenticated loopback channel; secret in memory on both processes during use.

5. **Stronghold or encrypted file in `app_local_data_dir` (Jan-like)**  
   - *Pros:* predictable across Linux headless; no D-Bus; both processes can read **same file** if path agreed and permissions set.  
   - *Cons:* not OS-isolated; key derivation/passphrase policy needed; Stronghold adds vault password UX if used for all secrets.

6. **Hybrid: SS/keyring when available, encrypted file fallback (Jan pattern)**  
   - *Pros:* best-effort desktop integration + headless Linux.  
   - *Cons:* two code paths; test matrix; macOS ad-hoc prompts remain for keyring path.

7. **Do nothing for Linux headless beyond file fallback**  
   - *Pros:* honest about missing Secret Service.  
   - *Cons:* weaker than SS when SS exists.

**Cross-cutting constraints to weigh:**

- **Ad-hoc macOS + frequent updates** penalize **OS keychain** unless releases move to **stable Developer ID signing** (Apple/Electron guidance above).  
- **Two executables** penalize **split read/write** across Rust and Node on macOS.  
- **`registry.ts` today** only understands env — any store requires a **new resolution path** (and policy for `providers.json` never holding plaintext keys).

---

## References (primary)

- Apple Code Signing Guide: [Introduction](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Introduction/Introduction.html), [Requirement Language](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html)
- Tauri v2: [Sidecar](https://v2.tauri.app/develop/sidecar/), [Stronghold plugin](https://v2.tauri.app/plugin/stronghold/), [Store plugin](https://v2.tauri.app/plugin/store/), [macOS signing / ad-hoc](https://v2.tauri.app/distribute/sign/macos/)
- `tauri-plugin-shell` spawn env: [`process/mod.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)
- `keyring-rs` / stores: [repo](https://github.com/open-source-cooperative/keyring-rs), [macOS `keychain.rs`](https://github.com/open-source-cooperative/apple-native-keyring-store/blob/main/src/keychain.rs)
- `@napi-rs/keyring`: [npm](https://www.npmjs.com/package/@napi-rs/keyring), [README](https://github.com/Brooooooklyn/keyring-node/blob/main/README.md)
- Windows: [`CredWrite`](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritea), [Environment variables](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables)
- Linux: [Secret Service spec](https://specifications.freedesktop.org/secret-service/latest/), [`proc_pid_environ(5)`](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html), [keyutils store](https://github.com/open-source-cooperative/linux-keyutils-keyring-store/blob/main/src/lib.rs)
- Electron: [`safe-storage.md`](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)
- VS Code: [`secrets.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/secrets/common/secrets.ts), [`encryptionMainService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/encryption/electron-main/encryptionMainService.ts)
- Jan: [`provider_secrets.rs`](https://github.com/janhq/jan/blob/main/src-tauri/src/core/server/provider_secrets.rs)
- Node: [`--env-file`](https://nodejs.org/api/cli.html#--env-fileconfig)
- Archived keytar: [GitHub `atom/node-keytar`](https://github.com/atom/node-keytar) (`archived: true`)

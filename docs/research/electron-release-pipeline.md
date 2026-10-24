# Electron release pipeline: GitHub Actions → GitHub Releases

Research for wayfinder map [#382](https://github.com/ccanalesb/lightroom-tagger/issues/382) / ticket [#407](https://github.com/ccanalesb/lightroom-tagger/issues/407). Builds on unsigned-install research ([`unsigned-electron-install.md`](https://github.com/ccanalesb/lightroom-tagger/blob/research/unsigned-electron/docs/research/unsigned-electron-install.md) on branch `research/unsigned-electron`).

Scope: **electron-builder** publishing to **GitHub Releases**, CI matrix for **macOS arm64 + Windows x64 + Linux x64 (best-effort)**, **unsigned v1**, public downloads. Method: primary sources (electron-builder docs/source, GitHub docs, example repos). **Unconfirmed** items are marked.

---

## TL;DR

- **Publishing is explicit in electron-builder v27:** pass `--publish onTag`, `onTagOrDraft`, `always`, or `never` (or equivalent config). v27 removed implicit CI publish detection ([publish docs](https://www.electron.build/publish), [v27 breaking changes](https://www.electron.build/migration/v27-breaking-changes#implicit-publish-removed)). With `GH_TOKEN` or `GITHUB_TOKEN` set, default provider is GitHub when `publish` is configured or inferred.
- **GitHub Releases from electron-builder:** default `releaseType` is **`draft`** ([GithubOptions](https://www.electron.build/publish#github)). **`onTag`** creates/uploads only when CI sees a tag push; **`onTagOrDraft`** also publishes when a matching **draft** release already exists (electron-builder’s recommended “draft release + CI attaches artifacts” flow). **`releaseType: "release"`** publishes immediately (**unconfirmed** whether all matrix legs must finish before you promote—many OSS apps avoid this by **`--publish never`** on builders and a final **`softprops/action-gh-release`** job).
- **Workflow permissions:** release create/upload needs **`permissions: contents: write`** on the job that talks to Releases ([automatic token authentication](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication)). Pass token as **`GH_TOKEN`** or **`GITHUB_TOKEN`** ([publish](https://www.electron.build/publish)). Optional split: **`GITHUB_RELEASE_TOKEN`** (write) for publish, read-only token embedded for updater ([publish](https://www.electron.build/publish)).
- **Runners (Oct 2026 labels):** **`macos-15`** / **`macos-14`** = Apple Silicon; **`macos-15-intel`** = x64 macOS ([workflow syntax](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#jobsjob_idruns-on)). **`windows-latest`** → Windows Server 2025 image ([runner-images](https://github.com/actions/runner-images)). **`ubuntu-latest`** → Ubuntu 24.04 x64. Build each OS on its own runner (v27: Windows targets on macOS CI need host **Wine**—prefer native Windows runner ([v27 breaking changes](https://www.electron.build/migration/v27-breaking-changes#toolsets-environment-variables))).
- **Caching:** `actions/setup-node` **`cache: npm`** per app lockfile; plus **`actions/cache`** on `@electron/get` dirs ([README](https://github.com/electron/get/blob/main/README.md))—see [Mark Text `release.yml`](https://github.com/marktext/marktext/blob/develop/.github/workflows/release.yml). **`electron-builder clear-cache`** clears builder’s default cache dir ([CLI](https://www.electron.build/cli)); **exact default path on disk: unconfirmed** in docs (cache toolsets under user cache is common practice).
- **v27 update manifests:** publishing with auto-update metadata **requires Ed25519-signed `latest*.yml`** unless **`updateManifest: false`** ([signed update manifests](https://www.electron.build/features/signed-update-manifests)). CI secret: **`ELECTRON_BUILDER_UPDATE_SIGN_KEY`** (base64 PEM from `electron-builder create-update-key`). **`updateManifest: false`** is the v1-friendly pair with unsigned Authenticode + manual macOS updates ([prior unsigned research](https://github.com/ccanalesb/lightroom-tagger/blob/research/unsigned-electron/docs/research/unsigned-electron-install.md)). **npm `latest` is still 26.x; v27 is `@next` alpha as of 2026-10-24** (`npm view electron-builder dist-tags`)—plan pin before adopting v27 rules in CI.
- **In-app “new version” (no auto-update on mac):** **`GET /repos/{owner}/{repo}/releases/latest`** ([REST](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)) returns **`tag_name`** for the latest non-draft, non-prerelease release. Unauthenticated limit **60 requests/hour/IP** ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-unauthenticated-users)). Prefer **conditional GET** with **`If-None-Match: <etag>`** when using a token (**304** does not consume primary quota when authorized—[best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests)); **unconfirmed** whether unauthenticated **304** spares the 60/h cap. Poll infrequently; persist etag on disk.
- **Versioning without a root workspace:** electron-builder reads **`version` from the desktop app `package.json`** (the project dir you build). Options: new **`apps/visualizer/desktop/package.json`** as single semver source; root **`VERSION`** file (Logseq); tag-only at CI (`github.ref_name`); **release-please** / **changesets** with manifest pointing at the desktop package only—backend **`0.0.0`** can stay private if not shipped in the artifact.
- **OSS patterns:** (1) **tag → matrix build → artifacts → one publish job** (Mark Text), (2) **`workflow_dispatch` + `--publish never` + draft/publish via action** (Logseq), (3) **parallel OS jobs + aggregate draft** (Zettlr), (4) **push master + `GH_TOKEN` + local dist** (Jitsi—artifacts not necessarily one combined release).

Decisions belong in grilling ticket [#392](https://github.com/ccanalesb/lightroom-tagger/issues/392).

---

## 1. electron-builder → GitHub Releases

### 1.1 Tokens and provider

| Input | Behavior |
|--------|----------|
| `GH_TOKEN` or `GITHUB_TOKEN` | Enables GitHub publisher; defaults to `[{ "provider": "github" }]` when publish policy is set ([publish](https://www.electron.build/publish)). |
| `GITHUB_RELEASE_TOKEN` | Used **instead of** `GH_TOKEN`/`GITHUB_TOKEN` **for publishing** only; updater may still use `GITHUB_TOKEN` ([publish](https://www.electron.build/publish)). |
| PAT (classic) | **`repo` scope** documented for local publish ([GithubOptions](https://www.electron.build/publish#github)). |
| Fine-grained PAT | **Contents: Read and write** sufficient per electron-builder note (Apr 2024, [publish](https://www.electron.build/publish)). |

Fine-grained **`GITHUB_TOKEN` in Actions** cannot gain extra scopes beyond workflow `permissions` ([create release API note](https://docs.github.com/en/rest/releases/releases#create-a-release) on workflow file changes).

### 1.2 `--publish` modes (CLI)

| Value | When artifacts upload |
|--------|------------------------|
| `onTag` | Tag push in CI only |
| `onTagOrDraft` | Tag push **or** existing draft for this version |
| `always` | Every build with publish policy |
| `never` | Build only; no upload |

If CI is detected, electron-builder docs recommend defaulting intent to **`onTagOrDraft`**; on tag CI, **`onTag`** ([publish → How to Publish](https://www.electron.build/publish#how-to-publish)).

**v27:** none of this runs unless `--publish` or config explicitly sets publish policy ([implicit publish removed](https://www.electron.build/migration/v27-breaking-changes#implicit-publish-removed)).

### 1.3 Draft vs published vs prerelease

**Config (`GithubOptions`):**

- **`releaseType`:** `"draft"` | `"prerelease"` | `"release"` — default **`draft`** ([publish](https://www.electron.build/publish#releasetype)).
- Env overrides: **`EP_DRAFT=true`** → draft; **`EP_PRE_RELEASE=true`** → prerelease ([publish](https://www.electron.build/publish#releasetype)).

**GitHub API semantics:** `draft: true` on create/update leaves the release unpublished until edited ([REST releases](https://docs.github.com/en/rest/releases/releases)). **`GET .../releases/latest`** excludes drafts and prereleases ([get latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)).

**electron-builder “recommended GitHub workflow”** ([publish](https://www.electron.build/publish#recommended-github-releases-workflow)):

1. Manually create a **draft** release whose tag is `v` + `package.json` version.
2. Push commits; CI attaches/replaces artifacts on that draft (`onTagOrDraft`).
3. Publish the release in the UI when ready (GitHub creates/updates the tag).

**Alternative (Mark Text):** matrix builds with **`--publish never`**, then **`softprops/action-gh-release`** with **`draft: true`**, upload files, **`gh release edit --draft=false`** ([`release.yml`](https://github.com/marktext/marktext/blob/develop/.github/workflows/release.yml))—works around **immutable release** repos where assets cannot be added after publish (**Mark Text comment in workflow**).

### 1.4 Tag naming

- v27: **`tagNamePrefix`** replaces `vPrefixedTagName`; default prefix **`"v"`** ([publish](https://www.electron.build/publish#github)).
- Set **`owner` / `repo`** explicitly in `publish` so `app-update.yml` cannot drift via `.git/config` detection ([publish → GitHub Repository](https://www.electron.build/publish#github-repository-and-bintray-package)).

### 1.5 Multi-job / matrix uploads

Two established patterns:

| Pattern | Pros | Cons |
|---------|------|------|
| **A. Each OS job runs `electron-builder --publish onTagOrDraft`** | Simple; electron-builder uploads yml + installers per arch | Race on same release **unconfirmed** (GitHub API serializes uploads; retry behavior not verified here); all jobs need `contents: write` |
| **B. OS jobs `--publish never` + upload-artifact; one **`release` job** merges yml and publishes** | Deterministic release notes, checksums, merged `latest*.yml` (Mark Text) | More workflow code |

Logseq and Zettlr use pattern B ([Logseq](https://github.com/logseq/logseq/blob/master/.github/workflows/build-desktop-release.yml), [Zettlr](https://github.com/zettlr/zettlr/blob/develop/.github/workflows/build.yml)).

---

## 2. GitHub Actions triggers

| Trigger | Typical use | Examples |
|---------|-------------|----------|
| **`push: tags: ['v*']`** | Semver tag = release identity | [Mark Text `release.yml`](https://github.com/marktext/marktext/blob/develop/.github/workflows/release.yml) |
| **`workflow_dispatch`** | Manual channel (nightly/beta), inputs for draft/prerelease | [Logseq `build-desktop-release.yml`](https://github.com/logseq/logseq/blob/master/.github/workflows/build-desktop-release.yml) |
| **`push` to default branch** | Continuous build; may or may not publish | [Jitsi `ci.yml`](https://github.com/jitsi/jitsi-meet-electron/blob/master/.github/workflows/ci.yml) (sets `GH_TOKEN`, runs `npm run dist`) |
| **Schedule** | Nightlies | Zettlr (optional), Logseq (commented) |

**Options for #392:**

1. **Tag-only releases** — version in desktop `package.json` bumped on release branch; tag `vX.Y.Z` triggers matrix + publish.
2. **Dispatch-only** — human picks ref + draft/prerelease (Logseq-style).
3. **Hybrid** — dispatch for RC; tag for stable (**unconfirmed** preference).

**Concurrency:** Mark Text uses `group: release-${{ github.ref }}` ([`release.yml`](https://github.com/marktext/marktext/blob/develop/.github/workflows/release.yml)). Zettlr cancels in-progress builds on same workflow ([`build.yml`](https://github.com/zettlr/zettlr/blob/develop/.github/workflows/build.yml)).

---

## 3. `GITHUB_TOKEN` permissions

Minimal pattern for a job that creates/edits releases and uploads assets:

```yaml
permissions:
  contents: write
```

Jobs that only **download** artifacts from Actions API also need **`actions: read`** (Mark Text release job comment: [`.github/workflows/release.yml`](https://github.com/marktext/marktext/blob/develop/.github/workflows/release.yml)).

Workflow-level **`permissions: contents: read`** with **`contents: write` on the release job** is a common hardening pattern (Mark Text).

**Rate limit for `GITHUB_TOKEN` in Actions:** 1,000 requests/hour/repository ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github_token-in-github-actions))— ample for release automation; not for end-user update checks.

---

## 4. Runner matrix (macOS arm64, Windows x64, Linux x64)

Official **`runs-on` labels** (GitHub docs, 2026):

| Target | Suggested label | Notes |
|--------|-----------------|--------|
| macOS **arm64** | `macos-15` or `macos-14` | Apple Silicon images ([workflow syntax](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#jobsjob_idruns-on)) |
| macOS x64 (if ever) | `macos-15-intel` | Not required for v1 arm64-only map |
| Windows **x64** | `windows-latest` | Windows Server 2025 image ([runner-images](https://github.com/actions/runner-images)) |
| Linux **x64** | `ubuntu-latest` | Ubuntu 24.04 |

**Logseq** (6 desktop legs): `macos-15-intel`, `macos-14`, `ubuntu-22.04`, `windows-latest` ([workflow](https://github.com/logseq/logseq/blob/master/.github/workflows/build-desktop-release.yml)). **Mark Text** release matrix matches that set ([`release.yml`](https://github.com/marktext/marktext/blob/develop/.github/workflows/release.yml)).

**This repo’s contract CI** uses Node **24** on `ubuntu-latest` ([`.github/workflows/ci.yml`](https://github.com/ccanalesb/lightroom-tagger/blob/master/.github/workflows/ci.yml)). **electron-builder v27** requires Node **≥ 22.12.0** ([v27 breaking changes](https://www.electron.build/migration/v27-breaking-changes#nodejs-22120-required))—compatible.

**macOS unsigned v1:** set **`mac.sign.identity: "-"`** on macOS CI ([unsigned research](https://github.com/ccanalesb/lightroom-tagger/blob/research/unsigned-electron/docs/research/unsigned-electron-install.md)).

---

## 5. Caching

| Layer | What to cache | Key idea |
|-------|----------------|----------|
| **npm** | `actions/setup-node` with `cache: 'npm'` and lockfile path per package dir | Zettlr, Mark Text setup |
| **Electron binary** | `$XDG_CACHE_HOME` or `~/.cache/electron`, `~/Library/Caches/electron`, `%LOCALAPPDATA%/electron/Cache` | [@electron/get](https://github.com/electron/get/blob/main/README.md); [Mark Text `release.yml`](https://github.com/marktext/marktext/blob/develop/.github/workflows/release.yml) |
| **electron-builder toolsets** | **Unconfirmed** default dir; use `electron-builder clear-cache` when debugging ([CLI](https://www.electron.build/cli)) | Pin electron-builder version in cache key |
| **Optional: apt** | Linux `dpkg`/`rpm` build deps | Install step each run unless custom image |

Separate cache keys **per OS** (`electron-${{ matrix.os }}-${{ hashFiles('package.json') }}` in Mark Text).

---

## 6. electron-builder v27: Ed25519 update manifest vs `updateManifest: false`

**As of npm on 2026-10-24:** `latest` → **26.18.0**; **v27** → **`next`** (`27.0.0-alpha.12`). Map assumptions should pin **`electron-builder@next`** or a specific alpha until v27 stable ships.

### 6.1 Signed manifests (default in v27 when publishing)

When a publish policy emits `latest*.yml`:

- Build **fails** without a signing key unless opted out ([signed update manifests](https://www.electron.build/features/signed-update-manifests)).
- Generate key: **`electron-builder create-update-key`**.
- CI (preferred):

```yaml
env:
  ELECTRON_BUILDER_UPDATE_SIGN_KEY: ${{ secrets.ELECTRON_BUILDER_UPDATE_SIGN_KEY }}
```

Value = **base64-encoded PEM** (single line) ([signed update manifests → CI secrets](https://www.electron.build/features/signed-update-manifests#ci-secrets)).

- Public key is embedded in **`app-update.yml`** as **`updateManifestPublicKey`** automatically; do not set `updateManifestPublicKey` in publish config (rejected—[scheme](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/scheme.json)).
- Optional config: **`updateManifest.signingKey` / `signingKeyFile`**, **`updateManifest.publicKey`** for rotation ([v27 breaking changes](https://www.electron.build/migration/v27-breaking-changes#signed-update-manifests-are-required)).

Works **without Authenticode** for Windows/Linux updater trust (manifest signature ≠ installer signature). Still need **`win.verifyUpdateCodeSignature: false`** for unsigned NSIS ([unsigned research](https://github.com/ccanalesb/lightroom-tagger/blob/research/unsigned-electron/docs/research/unsigned-electron-install.md)).

### 6.2 Opt out: `updateManifest: false`

```yaml
# electron-builder.yml (illustrative)
updateManifest: false
```

- Only explicit opt-out; env signing key is **ignored** when `false` ([PlatformSpecificBuildOptions.updateManifest](https://www.electron.build/configuration/configuration#updatemanifest)).
- Unsigned manifests log a warning; electron-updater 7 **rejects** unsigned manifests if app was built **with** a trust key—field installs need consistent policy ([signed update manifests](https://www.electron.build/features/signed-update-manifests)).

**v1 fit:** macOS has **no** stock auto-update unsigned; **`updateManifest: false`** simplifies CI if only Win/Linux use electron-updater, or if mac builds omit updater entirely.

### 6.3 Windows-specific v27 gotchas (if using updater)

- Missing **`publisherName`** / unsigned + default verification → build or update **fails** unless **`win.verifyUpdateCodeSignature: false`** ([v27 breaking changes](https://www.electron.build/migration/v27-breaking-changes#missing-publishername-fails-update-verification)).

---

## 7. In-app “new version available” via GitHub Releases API

For unsigned macOS (manual re-download) or a light-weight notice on all platforms:

### 7.1 Endpoint

**`GET /repos/{owner}/{repo}/releases/latest`**

- Public for public repos; returns **`tag_name`**, **`html_url`**, **`published_at`**, assets with **`browser_download_url`** ([get latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)).
- Compare **`tag_name`** (strip configured prefix, default `v`) to embedded app semver.

Alternatives:

| Approach | Rate limit | Notes |
|----------|------------|--------|
| REST **`/releases/latest`** | 60/h unauthenticated per IP ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)) | Simple |
| REST with **`If-None-Match`** | 304 sparing quota when **authenticated** ([best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests)) | Desktop app has no GitHub token—**unconfirmed** for anon |
| Fetch **`latest.yml`** from latest release asset URL | Not REST; **unconfirmed** abuse limits | Same feed as electron-updater; semver inside yml |
| Generic **`publish.provider: generic`** + static JSON on Pages/S3 | Your infra | Removes GitHub API from client |

**Recommendation shape for #392:** poll at most daily; store **`etag`** + last result in app data; compare semver; open **`html_url`** in browser.

### 7.2 Draft / prerelease visibility

Clients using **`/releases/latest`** **ignore drafts and prereleases** ([API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)). Betas need **`/releases` list** with filtering or a dedicated prerelease channel—product decision.

---

## 8. Versioning without a root npm workspace

Current layout: **`apps/visualizer/backend`** and **`apps/visualizer/frontend`** each **`0.0.0`**; root **`package.json`** is dev-only ([repo layout in ticket]).

electron-builder takes **`version` from the built app’s `package.json`** (and **`build`** config beside it).

| Option | Mechanism | Trade-off |
|--------|-----------|-----------|
| **A. Desktop package as source of truth** | Add `apps/visualizer/desktop/package.json` (`version`, `build`, scripts bundling FE+BE) | Clear; matches electron-builder defaults |
| **B. `VERSION` file** | CI reads file into env; `electron-builder --config.extraMetadata.version=$VERSION` | Logseq uses root **`VERSION`** ([Logseq release job](https://github.com/logseq/logseq/blob/master/.github/workflows/build-desktop-release.yml)) |
| **C. Tag-derived only** | `version: ${GITHUB_REF_NAME#v}` at CI; **no** bump commit | Tag is truth; local builds need git describe |
| **D. release-please** | Manifest lists desktop package path | Automated PRs + changelog; overhead for solo/small team |
| **E. Changesets** | Bump desktop package only | Good multi-package story without npm workspaces if configured |

**Alignment:** Ship one **user-visible semver** on the desktop artifact; backend/frontend **`0.0.0`** can remain if their versions are not exposed in About dialog.

**Tag ↔ package.json:** Mark Text validates **`v*`** tag semver then builds ([`release.yml`](https://github.com/marktext/marktext/blob/develop/.github/workflows/release.yml)). Zettlr refuses to build if **`v${package.json version}`** already exists ([`build.yml`](https://github.com/zettlr/zettlr/blob/develop/.github/workflows/build.yml)).

---

## 9. Release notes

| Source | API / tool |
|--------|------------|
| **Auto-generated** | `POST /repos/{owner}/{repo}/releases/generate-notes` or **`softprops/action-gh-release`** `generate_release_notes: true` + `previous_tag` ([REST](https://docs.github.com/en/rest/releases/releases#generate-release-notes-content-for-a-release); [Mark Text](https://github.com/marktext/marktext/blob/develop/.github/workflows/release.yml)) |
| **Config-driven** | `.github/release.yml` ([generate-notes](https://docs.github.com/en/rest/releases/releases#generate-release-notes-content-for-a-release)) |
| **Manual / template** | `body` or `body_path` (Mark Text macOS unsigned instructions + SHA256SUMS) |

Zettlr placeholder body until human edits draft ([`build.yml`](https://github.com/zettlr/zettlr/blob/develop/.github/workflows/build.yml)).

---

## 10. How established OSS Electron apps structure releases

| Project | Workflow file | Pattern summary |
|---------|---------------|-----------------|
| **Mark Text** | [`.github/workflows/release.yml`](https://github.com/marktext/marktext/blob/develop/.github/workflows/release.yml) | **`push: tags: v*`** → semver validate → **matrix** (linux/win/mac × arch) → artifacts → merge **`latest*.yml`** → **`action-gh-release`** draft → **`gh release edit`** publish; **`contents: write`** on release job only |
| **Logseq** | [`.github/workflows/build-desktop-release.yml`](https://github.com/logseq/logseq/blob/master/.github/workflows/build-desktop-release.yml) | **`workflow_dispatch`** inputs (beta/nightly/stable); **`electron-builder --publish never`** on Windows; separate compile job; **`nightly-release` / `release`** jobs with **`softprops/action-gh-release`** |
| **Zettlr** | [`.github/workflows/build.yml`](https://github.com/zettlr/zettlr/blob/develop/.github/workflows/build.yml) | **`workflow_dispatch` + schedule**; OS-specific jobs → **`prepare_release`** downloads artifacts, SHA256, **`action-gh-release`** **`draft: true`** for master/RC |
| **Jitsi Meet Electron** | [`.github/workflows/ci.yml`](https://github.com/jitsi/jitsi-meet-electron/blob/master/.github/workflows/ci.yml) | **Push/PR to master**; **`macos-latest` / `ubuntu-latest` / `windows-latest`**; **`GH_TOKEN`** + **`npm run dist`**; upload-artifact (no unified release job in this file) |
| **Mark Text PR builds** | [`.github/workflows/build.yml`](https://github.com/marktext/marktext/blob/develop/.github/workflows/build.yml) | Same **matrix labels** as release without publish—reference for CI parity |

None of the above depend on electron-builder **implicit** publish (all pre-v27 or explicit flags)—when upgrading to v27, add **`--publish`** explicitly everywhere.

---

## 11. Decision menu for #392 (no picks here)

1. **Publish mechanic:** electron-builder **`onTagOrDraft`** per OS vs **artifact merge + `action-gh-release`**.
2. **Trigger:** **`v*`` tag** vs **`workflow_dispatch`** vs both.
3. **Release lifecycle:** stay **`draft`** until human publishes vs auto **`release`**.
4. **Updater:** **`updateManifest: false`** + manual mac vs **Ed25519 key** in secrets for Win/Linux electron-updater.
5. **Version source:** desktop **`package.json`** vs **`VERSION`** vs tag-only.
6. **Client update UX:** GitHub **`/releases/latest`** vs **`latest.yml`** HTTP vs generic JSON.

---

## References

- electron-builder publish: https://www.electron.build/publish  
- electron-builder v27 breaking changes: https://www.electron.build/migration/v27-breaking-changes  
- electron-builder signed update manifests: https://www.electron.build/features/signed-update-manifests  
- electron-builder CLI (`clear-cache`, `create-update-key`): https://www.electron.build/cli  
- @electron/get cache locations: https://github.com/electron/get/blob/main/README.md  
- GitHub REST releases: https://docs.github.com/en/rest/releases/releases  
- GitHub Actions `GITHUB_TOKEN`: https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication  
- GitHub REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api  
- GitHub REST best practices (ETag): https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api  
- Prior unsigned install/update research: https://github.com/ccanalesb/lightroom-tagger/blob/research/unsigned-electron/docs/research/unsigned-electron-install.md  

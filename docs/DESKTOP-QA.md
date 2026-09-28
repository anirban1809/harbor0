# harbor0 desktop verification — 25 September 2026

**Result: functional defects remain.** On this Mac, 53 of 61 newly added desktop checks passed; eight failed reproducibly. The existing integration-enabled suite passed all 34 tests. Startup/security smoke testing and the existing sync integration script also passed. The standard macOS packaging command failed separately.

No application behavior was changed during this testing task. Three repeatable test scripts and their npm commands were added. Lint, TypeScript checks, and the existing unit tests pass with these additions.

## Results

| Check | Result |
| --- | --- |
| Existing unit/contract/integration suite (`npm run test:integration`) | 34 passed |
| Desktop functional workflows (`npm run test:desktop:functional`) | 31 passed, 1 failed |
| Transfer and sync resilience (`npm run test:desktop:resilience`) | 14 passed, 4 failed |
| Production auth protocol and UI edges (`npm run test:desktop:auth-ui`) | 8 passed, 3 failed |
| Existing Electron startup/security smoke test | Passed |
| Existing real-storage sync integration | Passed |
| Lint and TypeScript checks | Passed |
| macOS app-directory packaging | Failed: Electron version resolution |

The normal `npm run check` run passes 32 tests and deliberately skips the two integration cases; those two passed in the separate integration-enabled run. These counts do not represent cross-platform or live-cloud certification.

## Confirmed failures

### 1. High: resuming a paused folder misses cloud changes

Pause one sync root, create a cloud folder within it, run a sync cycle, then resume the root and sync again. The new folder remains absent locally. The shared feed cursor advances while paused roots are skipped, and changing root settings does not reconcile them.

Evidence: resilience check “Paused roots catch up on remote changes after resuming.” See [sync.ts:136](/Users/anirban/Documents/Code/files/apps/desktop/src/sync.ts:136) and [main.ts:390](/Users/anirban/Documents/Code/files/apps/desktop/src/main.ts:390).

### 2. High: removing an exclusion misses cloud content

Exclude `Excluded`, create that folder in the cloud, sync, then remove the exclusion and sync again. The cloud folder is not downloaded. The feed entries have already been consumed and no reconciliation occurs when the exclusion changes.

Evidence: resilience check “Removing an exclusion downloads cloud content previously skipped.” Same settings/cursor paths as issue 1. These are two failing scenarios with a shared recovery problem.

### 3. High: removing an exclusion does not restore local file watching

Start watching a root with `Excluded` excluded. Remove the exclusion and create `Excluded/new.txt`. No upload job appears. The watcher closes over the original root configuration, while settings updates only replace the database record.

Evidence: resilience check “Removing an exclusion makes the watcher pick up local files again.” See [sync.ts:46](/Users/anirban/Documents/Code/files/apps/desktop/src/sync.ts:46) and [main.ts:390](/Users/anirban/Documents/Code/files/apps/desktop/src/main.ts:390).

### 4. Medium: moving a cloud file outside a mapped root leaves its old local copy

Sync a file within a root, move it in the cloud to a folder outside that root, then sync. The old local file and mapping remain. The engine returns when the new location is outside the root without handling the existing mapping. This was reproduced with the engine's supported non-null remote-root mapping; the current desktop picker creates sync roots at the account root.

Evidence: resilience check “Moving a cloud file out of a sync root removes its old local copy.” See [sync.ts:372](/Users/anirban/Documents/Code/files/apps/desktop/src/sync.ts:372).

### 5. Medium: opening a favorite folder does not browse its children

Favorite a folder containing a non-favorite file, open Favorites, and click that folder. The breadcrumb changes, but the listing still contains favorites. The renderer updates the folder trail without changing the section, so it requests the favorites endpoint again.

Evidence: functional check “Opening a favorite folder navigates to its children.” See [renderer.tsx:51](/Users/anirban/Documents/Code/files/apps/desktop/src/renderer.tsx:51) and [renderer.tsx:245](/Users/anirban/Documents/Code/files/apps/desktop/src/renderer.tsx:245). A screenshot is saved in `test-results/desktop-functional/failure-12.png`.

### 6. Medium: browser sign-in failures are invisible

Start browser sign-in and deliver an invalid-state callback. The main process rejects the callback correctly and emits `harbor:error`, but the desktop shows no error. Cancellation and keychain failures use the same unhandled error channel.

Evidence: auth/UI check “Browser sign-in errors are displayed in the desktop window.” See [preload.ts:26](/Users/anirban/Documents/Code/files/apps/desktop/src/preload.ts:26); it exposes status/authenticated listeners but no error listener. OAuth provider responses were simulated for these protocol checks.

### 7. Medium: tray “Send a file” has no connected renderer action

Deliver the same `harbor:send` event used by the tray menu. Neither a file picker nor a send dialog opens. There is no preload/renderer subscription for this event. The tray event path was exercised programmatically; clicking the native tray menu itself was not automated.

Evidence: auth/UI check “Tray Send a file event opens a picker or a send dialog.” See [main.ts:246](/Users/anirban/Documents/Code/files/apps/desktop/src/main.ts:246) and [preload.ts:26](/Users/anirban/Documents/Code/files/apps/desktop/src/preload.ts:26).

### 8. Medium: Drive silently stops after the first 100 children

Create 101 children in a folder and open it in the desktop. Only 100 are rendered. The API returns the last item on a second page, but the renderer discards `nextCursor` and provides no pagination control.

Evidence: auth/UI check “A Drive folder with 101 children exposes every item.” See [renderer.tsx:56](/Users/anirban/Documents/Code/files/apps/desktop/src/renderer.tsx:56). The same response handling is shared by other listings, but their larger-page cases were not separately exercised.

### 9. Build blocker: the standard macOS packaging command fails

Command: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run package -w @harbor/desktop -- --dir`.

The builder exits before packaging: “Cannot compute electron version from installed node modules — version (`^44.4.5`) is not fixed in project.” The normal desktop source build succeeds. Pinning/configuring the resolved Electron version is a likely correction, but no packaging fix was applied or verified in this task. Signing was intentionally disabled for this local packaging attempt; signing was not the reported failure.

## What passed

- **Startup and isolation:** sign-in screen; no startup/uncaught renderer errors; sandbox and context isolation; no renderer Node access; working preload; API-path restrictions; available macOS keychain.
- **Authentication:** invalid local password handling; successful login; encrypted credentials with owner-only file permissions; session/roots/global-pause restoration after app restart; logout removes credentials; a different account cannot reuse the same profile. Production-mode protocol tests cover state rejection, S256 PKCE, callback replay rejection, cancellation rejection, token exchange, refresh, and keychain refusal using simulated provider responses.
- **Drive:** create/rename folders, browse folders and breadcrumbs, upload several files including zero-byte/text/11 MiB binary content, cancel file pickers, download and compare exact bytes, display favorites, trash/restore, and duplicate-name errors.
- **Transfers:** send to a local test account, cancel outgoing transfer, receive/accept/download/save a transfer, and decline an incoming transfer.
- **Devices and settings:** list sessions, revoke a separate test session and verify its access is denied, export diagnostics without tokens/full local paths, close to background and reopen the window.
- **Sync and backup:** select roots, reconcile cloud files, detect a new local file, global pause/resume, persist per-root options, reject overlapping roots and traversal, upload existing backup content, keep cloud edits from overwriting backup sources, and retain cloud backup files after local deletion. The Open action passes the configured path to the OS API.
- **Resilience and preservation:** actual 65 MiB multipart upload interrupted before part two, resume without resending part one, completed-upload replay, ranged partial-download resume and exact SHA-256 match, corrupt-download protection, symlink refusal, empty files, safely restart uploads after source changes, immutable versions and historical download, local/remote deletion, concurrent-edit conflict copies, folder rename/mapping, recovery of remotely deleted local folders, and queued offline work after reconnection.

## Environment and limits

The Electron processes, UI actions, OS credential encryption, local files, SQLite journals, DynamoDB Local, and MinIO object storage were real. Extended scenarios used disposable profiles and a dedicated local table/bucket named `harbor-desktop-qa-20260925`. Native file/save pickers were replaced with deterministic picker results, and the folder-reveal OS call was captured to verify its argument. All workflow transfers stayed between local synthetic accounts. No production cloud files or accounts were changed.

The two existing storage integration cases use their own temporary DynamoDB table and the pre-existing `harbor-local` MinIO bucket. Their object-cleanup behavior was not changed.

After the final run, the dedicated desktop QA table, bucket, and 46 stored objects were deleted, and the temporary API process was stopped. The original cloud-configured harbor0 app was left running. Evidence files and the reusable test scripts were retained.

Live Cognito hosted pages, real email delivery/password recovery, OS deep-link delivery from an external browser, interactive picker usability, Finder appearance, sleep/wake and extended background operation, signed/notarized distribution, installer behavior, Windows, and Linux remain unverified. A packaged-app runtime test was blocked by the packaging failure. The tests do not cover every network timing interleaving or very large storage/transfer workloads.

The current desktop UI does not expose every backend feature: there are no dedicated desktop controls for general search, moving Drive items, managing version history, toggling favorites, link/permission sharing, notifications, billing, or manually pausing/cancelling individual uploads. Absence of these controls is distinguished from the failing implemented behaviors above.

## Reproduction and evidence

Start the local Docker services and a local API first. The extended scripts default to `http://127.0.0.1:8787`; `HARBOR_TEST_API` can select another local API. Run against an isolated development backend because the scripts intentionally create accounts, files, folders, transfers, and device sessions.

```sh
npm run build -w @harbor/desktop
npm run test:desktop:functional
npm run test:desktop:resilience
npm run test:desktop:auth-ui
```

Each extended command currently exits with status 1 because of the confirmed application defects. Temporary profiles and local working files are removed by the scripts; their remote local-backend fixtures persist until the dedicated test table/bucket are cleaned up.

Machine-readable results and screenshots:

- [Functional results](/Users/anirban/Documents/Code/files/test-results/desktop-functional/results.json)
- [Resilience results](/Users/anirban/Documents/Code/files/test-results/desktop-resilience/results.json)
- [Auth and UI results](/Users/anirban/Documents/Code/files/test-results/desktop-auth-and-ui/results.json)
- [Signed-in screenshot](/Users/anirban/Documents/Code/files/test-results/desktop-functional/signed-in.png)
- [Diagnostics sample](/Users/anirban/Documents/Code/files/test-results/desktop-functional/diagnostics.json)

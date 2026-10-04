# Web + desktop test report — 2026-10-04

Run against the working tree on `main` (uncommitted changes included), local stack:
API restarted fresh on 127.0.0.1:8787, web `next dev` on :3000 → local API, DynamoDB Local + MinIO.

## Summary

| Suite | Result |
|---|---|
| `npm run lint` | ✅ pass |
| `npm run typecheck` (root, web, landing, admin) | ✅ pass |
| `npm run test:integration` (unit + integration, 62 files) | ✅ 382/382 |
| OpenAPI regen drift (`npm run openapi`) | ✅ no diff |
| `npm run test:e2e` (Playwright, web) | ✅ 18/18 |
| Web page sweep (Drive, Shared, Trash, Devices, Storage, Settings, Notifications, Backups) | ✅ no console/API errors after sign-in |
| API edge-case probe (60 checks, ad hoc) | ⚠️ 59/60 — 1 finding (B1) |
| `npm run test:sync` | ✅ pass |
| `npm run test:desktop` (smoke) | ✅ pass |
| `npm run test:desktop:functional` | ❌ stale script — with selectors updated: 28 pass, 2 removed-by-design, 1 env-only failure; **no app bugs** |
| `npm run test:desktop:resilience` | ⚠️ 14/19 — 1 real bug (B2), 4 stale tests |
| `npm run test:desktop:auth-ui` | ⚠️ 5/8 — 1 real bug (B3), 2 stale tests |
| `desktop-account-switch-check`, `desktop-incoming-check`, `trash-check` | ✅ pass |
| `desktop-archive-check`, `sync-page-check`, `backups-ui-check`, `desktop-layout-check`, `transfer-layout-check`, `shared-sync-ui-check`, `sync-mapping-check` | ❌ all stale (removed sidebar Sync/Backups, deleted `SyncPage`, outdated mock API) |

## Bugs found

### B1 — Server trusts the client's `contentHash`; a wrong hash makes the file permanently undownloadable on desktop (Medium)
- `POST /v1/uploads/{id}/complete` with a `contentHash` that does not match the uploaded bytes is accepted (200, `cloudState: AVAILABLE`). `completeUpload` in `apps/backend/src/domain.ts:890` only checks the size (`storage.head`), never the hash.
- Desktop downloads verify SHA-256 against that stored hash (`apps/desktop/src/transfers.ts:323,333`) and refuse the file ("Download integrity check failed"). So one buggy or malicious uploader produces a file that can never be synced or downloaded on desktop, including by transfer and shared-sync recipients.
- Fix options: verify the hash server-side (a checksum on the R2 multipart upload, or a hash worker), or treat the client hash as advisory and have desktop fall back gracefully.

### B2 — Moving a cloud file out of a synced folder leaves a stale local copy (Medium-Low)
- Repro: sync folder `S` contains `notes.txt`. Move it in the cloud to a folder outside `S`. The desktop keeps `S/notes.txt` forever.
- Cause: `SyncEngine.remoteItem` in `apps/desktop/src/sync.ts:1347-1348`. When `relative(root, item)` is `null` (the item is no longer under the root), the function returns early, so the local file and its journal mapping are never removed. The removal path at lines 1308-1337 is only taken for `deletedAt`.
- Effects I checked:
  - Deleting the leftover file does **not** trash the moved cloud file.
  - Editing the leftover creates a `notes (Conflict - …).txt` copy in `S`.
  - So there is no data loss, but there are stale files and confusing conflict copies.
- Fix: when `known` exists and `relative === null`, handle it like a remote deletion: `preserve()` the local file, then remove it and drop the mapping.
- This is covered by the existing resilience test "Moving a cloud file out of a sync root removes its old local copy".

### B3 — Tray menu "Send a file" does nothing (Low)
- `apps/desktop/src/main.ts:406-412` sends `harbor:send` to the renderer, but no listener exists for it in `preload.ts` or `renderer.tsx` (the other channels are wired at `preload.ts:48-93`). The click only brings the window forward.
- The listener was lost in commit ebe305a.
- Fix: expose an `onSend` bridge listener and open the file picker or send dialog from it.

### B4 — Possible watcher/journal race on `engine.stop()` (Low, plausible)
- In a harness run, a chokidar `addDir` event fired after `engine.stop()` and `journal.close()`, and threw an uncaught `database is not open` from the watcher callback (`apps/desktop/src/sync.ts:159`).
- Likely cause: a `tick()` already running when `stop()` begins can re-create a watcher after `stop()` cleared the watchers (`sync.ts:761`, `if (!this.watchers.has(root.id)) await this.watch(root)` has no `stopped` guard). The `queue` callback doesn't check `this.stopped` either.
- In the app this could surface on sign-out or account switch as an uncaught main-process exception.
- Suggested fix: guard `watch()` and `queue()` with `this.stopped`.

## Edge cases verified OK (API probe)
- Auth:
  - Requests with no token or a garbage bearer get 401.
  - A wrong password gets 401.
  - Malformed JSON gets 400.
- Names:
  - Duplicates and case-variant duplicates (`dup`/`DUP`) are rejected with 409.
  - `""`, `.`, `..`, `/`, `\`, whitespace-only, NUL and over-240-character names are rejected with 400.
  - Unicode, `CON`, `:*?"<>|` and trailing spaces are accepted. Desktop's `safeSegment` maps these to safe local names.
- Idempotency:
  - Replaying the same `operationId` returns the same item.
  - Reusing an `operationId` with a different payload gets 409.
  - Re-completing a finished upload gets 409.
- Moves:
  - Moving a folder into itself, into its descendant, or into a file is rejected.
  - A stale `baseRevision` gets 409.
- Uploads:
  - Zero-byte files work.
  - A size lie (more bytes than declared) is rejected.
  - Going over quota gets 409 `STORAGE_QUOTA_EXCEEDED`.
  - A negative size is rejected.
  - A missing parent gets 404.
  - An existing name gets 409.
- Cross-user isolation: Bob gets 403 when he tries to get, list, download, rename, delete, read versions of, upload into, or ZIP Alice's items.
- Transfers:
  - Transfers to yourself are rejected.
  - Duplicate items are rejected.
  - The sender can't accept their own transfer.
  - A cancelled transfer can't be accepted.
  - An accepted transfer is still downloadable after the sender trashes the original.
- Trash:
  - Restore works.
  - A trashed folder hides its descendants.
  - You can't create items inside a trashed folder.
- Search and paging:
  - Search with special characters, and an empty search, return normal results with no server error.
  - A garbage cursor gets 400.
  - A negative sync cursor gets 400.
  - A one-character user search returns no users.

## Stale tests (not app bugs) — should be updated
- **`scripts/desktop-functional.ts`.** The UI moved on:
  - Inline new-folder form.
  - Sync/Backups gone from the sidebar.
  - Duplicate "Upload files" buttons.
  - `.transfer-row` rows.
  - New dialog button labels.
  - Settings → "Pause sync and backups".
  - Backups have a one-hour quiet period, so tests must use "Back up now".
  - Backup files are read-only (`BACKUP_IMMUTABLE`).
  - The backup panel has no "Open" button.

  A working updated copy exists (28/31 pass). Its one remaining failure, "no uncaught errors", comes from macOS refusing notifications to the unbundled test Electron (`desktop_notification_failed`); that needs filtering in the check.
- **`scripts/desktop-resilience.ts`.** The pause and exclusion tests write `journal.root()` directly. The app uses `engine.updateRoot()`, which triggers a reconcile and re-watch. Through `updateRoot`, I checked that all three scenarios work. "Backup local deletion preserves the cloud copy" predates the one-hour quiet period and server-registered backup roots.
- **`scripts/desktop-auth-and-ui.ts`.** The duplicate-name check expects a dialog (it's now inline). The 101-children check expects 100 rows, but Drive renders 80 rows at a time with incremental "show more" (`file-collection.tsx:207`).
- **The Sync/Backups nav checks:** `desktop-archive-check`, `sync-page-check`, `backups-ui-check`, `desktop-layout-check` and `transfer-layout-check` click Sync/Backups sidebar buttons that were removed on 2026-10-02.
- **`shared-sync-ui-check`** imports the deleted `SyncPage`.
- **`sync-mapping-check`** uses a mock API that no longer satisfies the app's startup calls.

## Notes
- The local API's 600 requests/min per-user limit (`apps/backend/src/api.ts:229`) causes 429 flakes when desktop suites poll quickly or run in parallel.
- iOS/Android and the admin console were not in scope.

---

# Part 2 — Product edge cases (storage full, sharing, lifecycle)

**How this was tested:**
- Four parallel test passes against the local stack. Each used fresh accounts, with quotas shrunk directly on the account's profile record.
- Web was driven with Playwright against `localhost:3000`.
- Desktop was tested two ways:
  - with real `SyncEngine` instances (separate journals and real folders, plus two engines side by side for shared sync);
  - with isolated Electron runs for the UI.
- Screenshots and logs are in the session scratchpad under `evidence/{storage-web,storage-desktop,sharing,misc}/`.
- **Caveat:** a stale API process from 2026-10-01 (ports 8797/8798) was running background jobs against the same local DB during part of this testing. It has since been killed. The one result it affected (no storage-warning email after a background transfer save) was re-run afterwards and **works** (`storageAlertLevel` = 80 after the save).

## Priority bug list

### P1: data loss or a blocked core flow

**Status 2026-10-05: all five fixed (uncommitted), each with a regression test that fails before the fix.**

- **P1-1.** `driveLocations` stops at the first parent folder the viewer can't access (403/404), the same way breadcrumbs already did.
  - Test: `apps/web/test/drive-locations.test.ts`.
  - Checked in a real browser: the recipient now opens `Private/Team docs`.
- **P1-2.** There were two causes.
  - (a) The delivery-receipt check re-created the parents of a just-deleted folder (`safeParents(…, create=true)` in `sync-receipts.ts`). The folder delete then saw the folder still existed and skipped it.
  - (b) A remote folder deletion moved fully synced files into "(Recovered…)". Now only unsynced or edited files are kept (`removeSynced` in `sync.ts`).
  - Tests: `apps/desktop/test/sync-two-computers.test.ts` and `sync-receipts.test.ts`.
  - Checked with real file watchers on two engines against the local API: the cloud and both computers end up empty.
- **P1-3.** The engine now detects local renames and moves. A queued delete plus a queued new file with the same size and SHA-256 becomes a move/rename of the cloud item, in either order (`renamedTo` / `renamedFrom` / `moveRemote` in `sync.ts`). If the cloud refuses, it falls back to the old upload + delete.
  - Nothing is re-uploaded, so this works when storage is full and saves bandwidth on every rename.
  - Test: `sync-two-computers.test.ts`.
  - Checked against the local API with storage exactly full: the same item is renamed, with no issues.
- **P1-4.** The purge walk skips descendants that were trashed on their own. They stay in Trash and restore to My Drive.
  - Test: `apps/backend/test/domain.test.ts`.
- **P1-5.** The Next `/api` route now hands `fetch` a string body. Next re-wrapped the `Request` body as a stream, and undici rejected any 401 answer to it ("expected non-null body source"), which the proxy reported as a 503. The production in-process proxy (`runtime.ts`) was not affected.
  - Test: `apps/web/test/api-route.test.ts`.
  - Checked in a real browser: signing the web device out remotely now lands on `/login?next=/trash`.

Checks after the fixes:
- `npm run check`: 400 tests pass.
- `npm run test:e2e`: 18/18.
- `npm run test:sync`: passes.

| # | Bug | Where | Evidence / source |
|---|---|---|---|
| P1-1 | **Web can't open a shared folder that sits inside one of the owner's private folders.** The recipient sees "You do not have access to this item." The API listing returns 200, but the web resolves the item's location by walking the owner's private parent folders, gets a 403, and fails the whole page. Only folders at the owner's top level can be opened. | Web | `apps/web/components/drive-workspace.tsx:373-377`, `apps/web/lib/drive-locations.ts:27-28` |
| P1-2 | **Deleting a non-empty folder locally doesn't stick (desktop sync).** The other device keeps its contents as "Docs (Recovered by harbor0 …)" and then re-creates an empty `Docs` in the cloud, which comes back on both sides. Reproduced with two devices on one account and with shared sync. | Desktop | `apps/desktop/src/sync.ts:1314-1330` |
| P1-3 | **Renaming a file locally while storage is full takes it out of the cloud.** A local rename is treated as delete + new upload. The original is trashed, the new name is refused for lack of space, and other devices then delete their copies. Only the Trash copy is left. | Desktop | `sync.ts:1065` (no rename/move detection) |
| P1-4 | **Permanently deleting a folder also purges a child that was trashed separately.** The child disappears from Trash within 5 s and can't be restored (404). | Backend | `apps/backend/src/deletion.ts` purge walk (~165-200) |
| P1-5 | **A revoked or invalid refresh token on web leads to a permanent "harbor0 is temporarily unavailable" screen** with no way back to sign-in. The session proxy returns 503 BACKEND_UNAVAILABLE instead of 401. Reproduced on local `next dev`; the production proxy path (`runtime.ts:68`) has not been checked, so verify this on staging. | Web | `packages/api-client/src/session-proxy.ts:60-125` |

### P2: wrong behaviour that users will hit

**Status 2026-10-05: all fixed except P2-14, which is deferred by decision (leave the rate limit and upload flow as they are for now).** Regression tests fail on the previous commit.

- **P2-1** Abandoned uploads release their reservation.
  - Web: dismissing a failed upload, an error that can't be retried, closing the tab, and cancel all call `DELETE /v1/uploads/{id}`. The tab also warns before closing mid-upload.
  - Desktop: abandoned upload ids are kept in the journal and released at the start of each sync pass.
- **P2-2** The new error `OWNER_STORAGE_FULL` (409, no byte details) is used when a non-owner hits the owner's limit, and the owner gets one notification per hour. Web and desktop name the owner as the one out of storage. Desktop messages now include the needed and free bytes. Sync retries right away when the change feed shows storage was freed.
- **P2-3** Non-owners can't rename, move or trash a shared folder itself.
- **P2-4** Each person has their own favourites.
- **P2-5** Editors can restore old versions (charged to the owner).
- **P2-6** On a name clash, the web upload tray offers "Replace" or "Keep both". There is also an "Upload new version" menu item.
- **P2-7** The API returns a new `access` field on shared items. The web hides write actions for viewers, and editors can't change the shared folder itself.
- **P2-8** "Share access" is in the file menus on web and desktop. Shared → Sent can remove access.
  - *Gap:* `/v1/shares/sent` doesn't name who the item is shared with yet.
- **P2-9** The ZIP sanitises entry names and de-duplicates them instead of failing.
- **P2-10** Moves check the depth of the whole subtree being moved. Create, list and upload use the same depth limit.
- **P2-11** The transport handles non-JSON errors (`BACKEND_UNAVAILABLE`). Desktop treats 5xx and network errors as an outage of the whole pass, with backoff. (Request timeouts already shipped in bba1a81.)
- **P2-12** The `~id` suffix now goes before the extension, and `%` and `#` are kept. Files already synced keep their old-style local name.
- **P2-13** Sorts that need the whole folder load the remaining pages first.
- **P2-15** Desktop shows a persistent notice and an OS notification when a sync folder is detached (owner stopped sharing, folder deleted, or removed elsewhere). The sign-in screen explains a remote sign-out.
- **P2-16** Notifications are newest first, go only to the other party, are de-duplicated on re-share, and include `SHARE_REVOKED`. Their data now has `actorName`, `itemName` and ids. The web shows specific text with links, an unread section in the drawer, and "Mark all as read".
- **P3**
  - Storage warnings re-arm when space is freed.
  - The storage audit counts bytes held by transfers.
  - "Back up now" checks free space before saying it's backing up.
  - The desktop sidebar flags failed backup runs.

| # | Bug | Where | Source |
|---|---|---|---|
| P2-1 | **Reserved storage is held for 24 h after an abandoned upload.** It happens when the user: dismisses failed uploads ("Dismiss finished uploads"); closes the tab mid-upload; hits a revision conflict or revoked access during an upload; or deletes or changes a file locally during its desktop upload. New uploads are then refused while the meter shows free space, and the Storage page shows a phantom "150 KB uploading". Nothing calls `DELETE /v1/uploads/{id}`. | Web + Desktop | `app-shell.tsx` `dismissUploads()` ~803, `apps/web/lib/upload.ts:180-183`, `apps/desktop/src/sync.ts:1096`, `transfers.ts:156,188` |
| P2-2 | **Over-quota errors blame the wrong account.** An editor of a shared folder, or a shared-sync recipient, whose *owner* is full gets "There is not enough available storage." / "Your cloud storage is full", with a "Manage storage" link to their own page that shows 50 GB free. The owner gets no notice, and the error details expose the owner's free bytes. | Web + Desktop | `domain.ts:745`, `sync-page.tsx:118` |
| P2-3 | **Editors can rename or trash the owner's shared folder itself** on direct shares; the owner isn't notified. Shared sync blocks this. | Backend | `domain.ts:552-560` |
| P2-4 | **An editor's "favourite" sets the owner's favourite** and bumps the item's revision. | Backend | `domain.ts:618` |
| P2-5 | **Editors can upload new versions but can't restore an old one** (404 "The item was not found."). | Backend | `domain.ts:1307` |
| P2-6 | **The web can't upload a new version of an existing file or replace it.** Uploading a file whose name already exists fails with "An item with this name already exists." and the only option is a Retry that fails the same way. | Web | `apps/web/lib/upload.ts:99`, `app-shell.tsx:689` |
| P2-7 | **The web ignores share permissions.** Viewers see Upload, New folder, Rename, Move and Trash; every one fails with "You do not have access to this item." | Web | `drive-workspace.tsx:642-650` |
| P2-8 | **There is no way to create a direct share from web or desktop.** The share dialog exists but no menu item opens it; only the iOS and Android apps can share. | Web + Desktop | `drive-workspace.tsx:1013-1056` |
| P2-9 | **One `:` in a filename fails the whole folder ZIP** ("Cannot archive this filename"), even though `:` is allowed on upload and rename. | Backend | `apps/backend/src/archives.ts:71-77` |
| P2-10 | **Moving a deep folder tree bypasses the 32-level limit**, which makes its contents unreachable: listing returns 400 PATH_TOO_DEEP, search skips them, and ZIP fails. There's also an off-by-one: a folder can be created at depth 33 but not listed. | Backend | `domain.ts:603`, `:366` |
| P2-11 | **Desktop API requests have no timeout**, so a hung connection stalls sync (it stayed "running" for over 60 s after the API recovered). **HTML 5xx responses are parsed as JSON**, so the user sees "Unexpected token '<'…". **Plain 500 errors are retried at about 2 requests/s with no backoff.** | Desktop | `packages/api-client/src/index.ts:35-50`, `sync.ts:446` |
| P2-12 | **Desktop puts its `~hash` suffix after the file extension** for cloud names that are illegal locally (e.g. `a_b.txt~fd565724`), so the file loses its type association. `%` and `#` are replaced even though they're legal on every OS. | Desktop | `apps/desktop/src/paths.ts:11` |
| P2-13 | **Web "Modified, newest first" sorting only covers the pages already loaded** in large folders: the top row was really the 538th newest of 1,000. | Web | `apps/web/lib/drive-view.ts:37` |
| P2-14 | **Bulk desktop sync is capped at about 2.7 small files/s** by the 600 req/min per-user rate limit (about 4 API calls per file). 1,000 files took 367 s, with ~55 s stalls. The status meanwhile stays "Uploading 100%". | Desktop + Backend | `apps/backend/src/api.ts:229` |
| P2-15 | **Sync folders detach silently on desktop.** When the owner revokes a shared sync or trashes and restores the folder, the folder just disappears from the recipient's list, with no message and no notification. After a restore the recipient must notice it and re-join. A desktop signed out from another device lands on a plain sign-in screen with no explanation. | Desktop | `sync.ts:723-744`, `main.ts:109` |
| P2-16 | **Notifications are listed oldest first** (and capped at 50, so new ones can be cut off). They are generic ("Someone sent you files", with no sender name), have no links, and miss most sharing events (edits, revokes, trashes). On a transfer cancel, the *sender* is notified of their own action and the recipient gets nothing. The bell's Activity drawer says "No activity yet" even when there are unread notifications. | Backend + Web | `domain.ts:2430-2432`, `transferAction`, `app-shell.tsx:1631-1653` |

### P3: minor bugs

- **Storage warning emails aren't re-sent after space is freed.** Delete and empty-trash never reset `storageAlertLevel`, which contradicts the code comment (`domain.ts:1032`).
- **The storage audit undercounts bytes held for sent transfers.** `RETAINED_FOR_TRANSFER` rows count 0 (`storage-audit.ts:119`).
- **Restoring the *current* version duplicates it and charges its storage again** (`domain.ts:1296-1358`).
- **About 7% of concurrent uploads fail with 409 CONCURRENT_UPDATE**, and neither web nor desktop retries them (`repository.ts:316-334`).
- **Account deletion leaves transfers PENDING.** Transfers sent *to* the deleted user stay pending forever on the sender's side, and transfers *from* them can still be accepted (`domain.ts:2491-2538`).
- **The desktop sidebar says "All synced" while a backup has failed**, because the server never sets the ERROR state (`renderer.tsx:743`). The backup panel shows "0 B in total" next to a 2 KB file.
- **An upload's expiry job is dropped if it runs before the expiry time**, which would hold the reservation forever (`domain.ts:2673`). This is suspected only and hasn't happened in normal flow.

## How the apps behave when storage is full (OK unless noted)

**API**
- An upload that doesn't fit gets 409 `STORAGE_QUOTA_EXCEEDED`, with `requiredBytes` and `availableBytes` in the details.
- The exact boundary is enforced: the remaining bytes fit; one more byte gets 409.
- Concurrent reservations are enforced.
- Cancelling an upload releases its reservation, and upload expiry releases it too.
- 0-byte files and new folders are still allowed when full.

**Trash and versions**
- Trash counts toward usage; permanent delete and empty trash free space immediately.
- Every version counts toward usage. A new version or a version restore is refused when it doesn't fit.
- When the server refuses a version restore or a transfer save for space, its error has no size details.

**Over quota (quota lowered below usage)**
- List, download, preview, rename, move, new folder, trash, restore and ZIP all keep working; only uploads are refused.
- *UX:* the web still says "You're running low on storage", the meter never turns red, there's no "full" state, and nothing points to ways to free space.

**Warnings**
- 80/95/100% warnings are **email-only**. Nothing goes to in-app Notifications, and the web banner uses a different threshold (90%, including reservations).

**Web upload UI**
- A failed upload shows a red row with the message, plus Retry and X.
- *UX:*
  - The message doesn't say how much space is needed.
  - The whole file is hashed before the server can refuse it.
  - A folder upload says "1 of 3 files failed" without naming the file.
  - The tray total includes failed bytes.

**Transfers**
- Accepting a transfer needs no space. "Save to My Drive" is all-or-nothing for folders and gives a clean 409 when it doesn't fit.

**Desktop sync**
- A file that doesn't fit becomes a per-file "Your cloud storage is full" card with a "Manage storage" button. The sidebar shows "N sync problems" and an in-app alert appears.
- Smaller files keep uploading, and downloads, deletes and renames keep syncing.
- Retries back off 4 s → 5 min, about 0.2 requests/s, so the API isn't hammered.
- *UX:* after space is freed, sync resumes only when the per-file retry timer runs out (up to 5 min). Pause → Resume retries immediately.
- *UX:* there's no OS notification, and the web can't see desktop sync problems.

**Desktop edits**
- When an edited file no longer fits and a remote edit arrives, the remote version wins and the local edit becomes a conflict copy that uploads later. No data is lost.

**Desktop backups**
- When only part fits, the run is marked PARTIAL ("Some files skipped"). When nothing fits, it's FAILED.
- Retries happen about every 60 s while full, and each adds another FAILED run to History.
- It completes automatically once space is freed.
- *UX:* "Back up now" shows "Backing up 1 changed file ✓" and then fails 0.3 s later.

## How sharing behaves (OK unless noted)

**Direct shares, as editor**
- A new version from the editor reaches the owner, charged to the owner's quota. The owner's open page updates within 0.1 s.
- *UX:* the recipient only sees the owner's changes after about 60–70 s of polling, with no live push. A folder rename wasn't picked up within 90 s, and the owner gets no notification of edits.
- Same-revision conflicts get 409 REVISION_CONFLICT; the web shows "This item changed on another device."
- Items an editor creates belong to the owner, and items an editor trashes go to the owner's Trash. Editors can't move items out into their own drive.

**Direct shares, as viewer**
- Every write gets a clean 403 from the API; ZIP download is allowed.

**Owner-side changes**
- When the owner trashes, restores or purges, the recipient's view follows. A revoke shows "no access" within about 6 s.
- Download URLs issued before a trash or purge keep working for their 5-minute life.

**Share requests**
- Sharing with yourself or an unknown person gets 404. A duplicate share is idempotent, and changing permission updates the existing share.
- *UX:* every repeat share re-notifies the recipient, and a recipient trying to re-share gets a misleading 404.

**Transfers**
- The recipient always gets a **snapshot**: the sender's later edits or deletes don't affect it.
- Expiry gives 410. Cancel after accept and accept after decline both give 409. Resending after a decline works.
- Saving onto a name that already exists gets 409 with no "keep both" option.

**Shared two-way sync** (tested with two real engines)
- Edits flow both ways.
- Concurrent offline edits: the owner's version wins and the recipient's is kept as a conflict copy on both sides.
- Recipients can't rename or trash the shared root.
- Local files are kept when the owner revokes.

## Other behaviour (OK unless noted)

**Trash and restore**
- Restoring a file whose parent is in trash puts it in the My Drive root. *UX:* nothing tells the user it moved.
- Restoring onto a name that now exists gets 409, with no rename or keep-both option.
- *UX:* a trashed folder can't be browsed before it's restored.
- Empty Trash with 125 items is instant and paginates correctly.

**Versions**
- 60+ versions are kept and download correctly, and they survive rename, move, and trash/restore.

**Web sessions**
- When cookies are lost, a "You've been signed out" dialog appears and re-login returns the user to the folder they were in. (Revoked or invalid refresh tokens are the separate P1-5 bug.)
- Two open tabs: a rename shows in the other tab in under 0.1 s, a delete in about 2 s, an upload in about 5 s.

**Account deletion**
- All sessions are killed immediately and the username is freed. (Pending transfers are the P3 item above.)

**Names**
- Unicode and RTL names are normalised to NFC, and an NFD duplicate is rejected.
- Content-Disposition `filename*` round-trips exactly, and `%#?"'` names work end to end on web.

**Search**
- Case-insensitive, and ß matches ss. Trashed items are excluded and new items are found immediately.
- *UX:* accents aren't folded, so "resume" doesn't find "Résumé".

**Web upload interruptions**
- *UX:* going offline mid-upload fails with a raw "Failed to fetch" and doesn't resume when the connection returns; a manual Retry resumes from the completed parts.
- *UX:* closing the tab mid-upload gives no beforeunload warning.

**Desktop**
- An offline queue (create, modify, delete, mkdir) replays correctly when the connection returns.
- A desktop signed out from another device keeps its local files, and re-signing in restores its sync roots.

**Folder ZIP**
- An empty folder, 276 files, and cancelling mid-build all work.

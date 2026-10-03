# harbor0 for iOS

A native SwiftUI starting point for iPhone and iPad, using the existing Harbor0 API. Requires Xcode and iOS 17 or later; no CocoaPods or third-party Swift packages.

## Run

Open `Harbor0.xcodeproj`, select the **Harbor0** scheme and an iPhone simulator, then Run. The normal app connects to the deployed Harbor0 API. Sign in, or create and verify an account in the app.

On this Mac, the development simulator is named **Harbor0 iPhone**. For a physical iPhone, select your Apple team under Signing & Capabilities, connect and trust the phone, enable Developer Mode when prompted, and choose it as the destination. Device signing and physical-device testing have not been configured by this project.

## Included

The interface mirrors the web app's phone layout (`apps/web/app/styles/mobile.css`) and covers its features:

- **Frame**: sticky translucent top bar (brand mark, pill search, activity bell with unread dot, avatar account menu) and a five-column bottom tab bar — Drive · Shared · Backups · Trash · More. More opens a bottom sheet with Devices, Storage, Settings, a theme toggle and the storage card. Toasts, the upload tray, ZIP/download status cards, offline and error banners match the web copy.
- **My Drive** with three pinned places first at the root — *Synced Folders*, *Backups* and *Archives* (My Drive › place › device › folder: one folder per computer or phone with folders there, from `GET /v1/sync/folders` `syncDevices`, `GET /v1/backups` states ACTIVE/PAUSED/ERROR vs ARCHIVED, and `GET /v1/devices`; backups from devices that are gone are grouped by their saved device name; places can't be selected, renamed, moved, shared or deleted; every level shows its storage from `GET /v1/drive/usage`, “At least …” when a count is partial), breadcrumbs, item count, list/grid switch, type/modified filter chips, sort sheet (folders first, system files), low-storage warning, skeletons, empty states and pull-to-refresh. Rows show kind tiles, size · date, favorites and sync status (Synced/Syncing/Pending). Long-press or checkboxes select; a floating dock offers Download, Send, Move, Move to trash and more. The FAB opens Upload files / Upload a folder / New folder.
- **Item actions** (bottom-sheet menu): open (Quick Look), download (share sheet → Save to Files), folder ZIP download with progress and cancel, send (`@username` or email), share with Viewer/Editor permission, rename (selects the base name), move with a folder picker, favorites, details, version history (download/restore, “Restore locally” for backups), remove from sync, disconnect backup, request a copy for older files still stored only on linked devices, move to trash. Read-only rules for Backups, Archives and Synced Folders follow the web.
- **Search** stays on the current page, like the web: in My Drive it shows “Search results” with location tabs and, inside a folder, “Search this folder”; in Trash it filters Trash (“Items in Trash matching …”); on any other page the content is replaced in place by file results (“Files matching …”, Clear search, file menu, Send, pagination) and the tab stays active. Switching tabs clears the search.
- **Uploads**: multi-file picker and folder upload (subfolders recreated), one-at-a-time queue with per-file/folder progress, pause, resume/retry and cancel.
- **Shared**: Received | Sent transfer cards (status badge, files with per-file download, “Show more files”, From/To, size, dates; Accept, Decline, Save to My Drive, Cancel transfer with confirmations), pagination and the Shared access card with Remove access.
- **Sync on this iPhone** (desktop parity): a Sync page (More › Sync, or the “This iPhone” card in My Drive › Synced Folders) with overall status, pause/resume, recent activity, problems that need attention (kept-both conflict copies with Open/Dismiss, unavailable folders, per-file errors with Retry) and files waiting for another device. *Sync a folder* picks a cloud folder (one already syncing elsewhere, any My Drive folder, or a new one) and where it lives on the phone: harbor0’s own folder in the Files app (On My iPhone › harbor0, the default) or any folder chosen in Files (kept with a security-scoped bookmark). Per folder: Show in Files, pause, excluded subfolders, share with other accounts (two-way sync invitations; accept/decline received ones), choose a different folder, stop syncing on this iPhone, or remove from sync everywhere. Folders syncing on other devices offer *Sync here*.
- **Backups**: folder list with status, detail with status summary, Stop backing up / Remove from Backups, Files & versions browser (file sheet with saved versions, Restore and Download) and History (restores and expandable backup runs). *Back up a folder* backs up any folder chosen in Files; folders from this iPhone add Back up now, Pause/Resume, Archive (final backup, then verified local files are removed) and Restore folder, and restores requested from any device are applied here.
- **Trash**: count, Empty Trash, list/grid, restore and permanent delete (single and multi-select), pagination.
- **More pages**: Devices (revoke), Storage (plan and breakdown), Notifications (mark read) and Settings — appearance (color mode, presets, per-mode custom colors with picker and hex input, saved to the account automatically), profile (display name, username), delete account, sign out.
- **Accounts**: in-app sign in, sign up (password rules), email confirmation with resend cooldown, forgot and reset password. Sign-in keeps IOS device registration, Keychain storage, signed device proof, refresh rotation, session restoration and remote sign-out.
- **Transfers**: coordinated local snapshots, streaming SHA-256, disk-backed multipart uploads with part retry and abort cleanup; downloads verify size and SHA-256 before preview or sharing.
- Theme tokens are the web's `tokens.css` (indigo Harbor default, Ocean/Forest/Violet/Sunset, derived Oklab mixes per surface), Geist from the bundled variable font, and lucide icons generated by `generate-icons.mjs`.

Manual uploads and downloads run in the foreground; keep the app open until they finish. Pausing an upload releases its reservation, so resuming starts that file again.

### harbor0 in the Files app (File Provider extension)

The `Harbor0FileProvider` target is a replicated File Provider extension embedded in the app; nothing is installed separately. After sign-in the app registers one domain per account (`FilesLocation.swift`), and **harbor0** appears under Files › Browse › Locations (iOS asks once to turn it on). It mirrors My Drive:

- iOS starts the extension by itself, so the location works while the harbor0 app is closed. Folders and files created, edited, renamed, moved or deleted in Files or any app's file picker are sent to harbor0 without opening the app. Deleting moves the item to harbor0's Trash.
- Files download when opened (iOS only supports on-demand download for third-party providers; it can evict them under storage pressure). Each download is checked by size and SHA-256. Files kept only on linked computers are requested from them (`request-content`), and opening waits up to a minute for one of them to provide the file. The server holds those provided bytes for an hour for this phone.
- An edit based on an older version is uploaded beside the newer one as `name (Conflict - iPhone - xxxxxxxx).ext`.
- Changes made elsewhere arrive through the account's change feed. The server wakes the extension with a silent File Provider push (`FilesPush.swift` registers the PushKit `fileProvider` token with `PUT /v1/devices/current/push`; no notification permission or alert is involved), and iOS then asks the extension for changes even while the app is closed. Pushes are best effort and iOS may delay them, so the app also signals a refresh when it comes to the foreground. Server setup: docs/DEPLOYMENT.md › iOS Files push.
- Backed-up folders are read-only.

The app and extension share the session through the `group.app.harbor0.ios` App Group (server and account) and the `$(AppIdentifierPrefix)app.harbor0.shared` keychain group. Sessions saved by earlier builds are moved there on first launch. The shared item is readable after first unlock, so uploads can continue while the phone is locked. Refresh tokens rotate, so each process adopts tokens the other has just saved instead of refreshing with a stale one. Signing out removes the location.

Physical devices: the App Group and keychain sharing must exist for your team. Xcode's automatic signing creates them when you build with your Apple ID signed in.

Backend requirements: `GET /v1/sync/changes?cursor=latest` (current feed position) and `request-content` from devices not linked to the folder. Both are in this repository but need a backend deploy; against an older server the extension reads the feed from the start and files kept only on computers can't be opened.

### How sync and backups run on the phone

`SyncEngine.swift` is a port of the desktop engine (`apps/desktop/src/sync.ts`, `backups.ts`, `sync-receipts.ts`) with the same protocol: the ordered change feed and checkpoints, `PUT /v1/sync/folders` membership, resumable multipart uploads with persisted state, downloads verified by size and SHA-256 before replacing a file, delivery receipts (`/v1/sync/items/:id/acknowledge`), `request-content` for older files still held only by other devices, conflict copies (`name (Conflict - iPhone - xxxxxxxx).ext`), recovered folders, backup runs with the one-hour quiet rule, archive/unarchive and pending restores. State lives in a per-account SQLite journal (`SyncJournal.swift`) under Application Support. Path rules are in `SyncPaths.swift`.

iOS has no file watcher for other apps' edits, so each pass scans the folder and compares it with the previous scan. Evicted iCloud Drive files (`.name.icloud` placeholders) are never treated as deletions. The device's sync identity is this session's device record (`POST /v1/sync/devices/register`).

The engine runs every 2 seconds while the app is open (remote checks back off from 2 to 30 seconds when idle), finishes in-flight work for up to ~25 seconds after the app moves to the background, and catches up in `BGAppRefreshTask`/`BGProcessingTask` runs that iOS schedules (`app.harbor0.sync.refresh`, `app.harbor0.sync.processing`). iOS decides when those run, so changes made elsewhere may only arrive the next time the app is opened. Synced files are always kept in the cloud; every device, including this phone, downloads changes from there.

Not included: a share extension, visible push notifications (the activity feed and polling replace the web's live updates) or Photos library backup.

## Test

Start the repository's local Docker services, then run from the repository root:

```sh
docker compose up -d
node apps/ios/test-ios.mjs
```

The runner creates its own temporary DynamoDB table and MinIO bucket, starts the real backend on loopback port 18988 and a failure-injection fixture on 18987, runs XCTest and XCUITest, then removes its test services and storage. It does not use production accounts or cloud storage. Override `HARBOR_IOS_DESTINATION` for another simulator. Additional arguments pass to `xcodebuild`, for example `-only-testing:Harbor0Tests`.

`SyncIntegrationTests` drive the real engine against the local backend: cloud → phone and phone → cloud sync including subfolders, delivery receipts, a concurrent-edit conflict, remote and local deletions, a manual backup run, a restore requested from another device, and archive followed by restore. Run them alone with `node apps/ios/test-ios.mjs -only-testing:Harbor0Tests/SyncIntegrationTests`.

Tests cover credential persistence failure, invalid/expired sessions, offline restoration, query escaping, invalid filenames, multipart retry, checksum rejection, and a 65 MiB round trip through the real local API/storage. The UI scenario covers invalid credentials, sign-in, My Drive › Synced Folders / Backups / Archives › device › folder, folder creation from the FAB, sync status, backup read-only rules, backup detail and history, Shared transfers, search on Shared staying on Shared and clearing back, trash restore/move-to-trash/permanent delete through bottom-sheet menus, theme persistence after relaunch, file preview and sign-out from the account menu. Appearance tests cover custom overrides, unsaved drafts and retry after a failed save. The real backend round trip also verifies account appearance persistence and trash/restore/empty operations. Native Files picker upload and Save to Files still need hands-on checks on a physical device.

Debug builds accept `HARBOR_API_URL` in the launch environment for an HTTPS API or a loopback HTTP API. Release builds always use the production endpoint and keep default HTTPS transport security. Debug HTTP exceptions are limited to local networking. Fixtures are never built into the app.

## Verified on 28 September 2026

- Xcode 26.6, iOS 26.5 simulator, Apple Silicon Mac.
- All 16 tests passed: 14 client/appearance/transfer tests, one real backend integration test and one end-to-end UI test.
- The real backend test uploaded and downloaded a 65 MiB file through isolated local DynamoDB/MinIO services, verified its checksum, persisted a custom account theme, exercised trash/restore/empty, restored the Keychain session and verified remote session revocation. The runner removed its database, bucket and test processes afterward.
- Simulator build and unsigned Release build for physical iOS devices succeeded. Release configuration has no HTTP transport-security overrides.
- All five tabs, independent folder navigation, backup history/read-only browsing, trash restore/delete, theme persistence after relaunch, preview open/close and sign-out were exercised through native UI automation. Screenshots were reviewed in Harbor light, Ocean light and Violet dark. Physical-device signing, production-account authentication and native Files provider interactions still require device/user testing.

Xcode test results and screenshots are retained under the ignored `build/Logs/Test` directory. This is a development starter, not an App Store submission.

## Interface direction

See [DESIGN.md](DESIGN.md). Screens follow the web phone layout one-to-one; reference screenshots of the iOS build are written to the ignored `build/screenshots` directory.

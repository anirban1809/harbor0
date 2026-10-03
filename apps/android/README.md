# harbor0 for Android

Native Kotlin and Jetpack Compose app for Android 8.0 (API 26) and later. It follows the [iOS app](../ios/README.md) and uses the same deployed harbor0 API. No backend changes are needed.

## Run or install

Open this directory in Android Studio, let Gradle sync, choose an emulator or USB-connected phone, and run **app**. Sign in, or create and verify an account, in the app.

Command-line builds require JDK 17, Android SDK platform 36 and build tools 35.0.0. Set `ANDROID_HOME` to the SDK directory or create an untracked `local.properties` containing `sdk.dir=/absolute/path/to/sdk`.

From the repository root:

```sh
apps/android/gradlew -p apps/android :app:assembleDebug
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
```

The debug APK is signed with the local Android development key and connects to production by default. It can be installed on a phone after allowing installs from the application used to open the APK. Its application ID is `app.harbor0.android.debug`; release uses `app.harbor0.android`.

Release builds succeed with `:app:assembleRelease` and produce an **unsigned** APK. Configure your own release signing key before distributing a production build or submitting to Google Play. Signing secrets are intentionally absent from the repository.

On the development Mac used for this implementation, the SDK is in `~/Library/Android/sdk`, JDK 17 is in `~/Library/Java/JavaVirtualMachines/temurin-17.jdk`, and the emulator is named `Harbor0_Android`.

## Included

The app follows the web app's phone layout (`apps/web/app/styles/mobile.css`) and covers the web features:

- **Shell:** top bar with brand mark, pill search, activity bell (unread dot, Activity sheet, “All notifications”) and avatar account menu (profile, storage, Account settings, Devices, Manage storage, Sign out). Bottom tabs Drive · Shared · Backups · Trash · More; More is a bottom sheet with Devices, Storage, Settings, a theme toggle and the storage card. Offline and error banners, toasts above the tab bar. Android Back closes sheets, clears selection or search, goes up folders, then returns to Drive.
- **Accounts:** sign in, sign up, email confirmation with resend cooldown, forgot/reset password and “Verify now” for unverified accounts, all in-app. Android device registration with a Keystore-held device key proof, encrypted credentials, token refresh/rotation, session restoration and remote sign-out.
- **My Drive:** cloud files, with three pinned virtual places first at the root: **Synced Folders**, **Backups** (active, paused or failing backup roots) and **Archives** (archived roots). Each lists one folder per computer or phone (`GET /v1/devices`; sync folders matched by `syncDevices`, backup roots by device key, then session id, then name, with unmatched roots under their saved device name), then that device's folders, which open in the normal browser as My Drive › place › device › folder (`DriveModel.kt` `placeGroups`). Storage used is shown at every level (places, devices, folders, and folder rows plus the current folder's total inside them) from `GET /v1/drive/usage`, fetched in batches of 50 after the list shows; partial counts read “At least …” or “… +”; item count, list/grid views, Type/Modified/Sort chips (folders first, system files), breadcrumbs, low-storage warning, sync status badges, favorites, skeletons, pull-to-refresh, paging. FAB menu (Upload files, Upload a folder, New folder); multi-file upload queue with per-file progress, pause/resume/cancel and folder uploads that recreate subfolders. Long-press or checkbox selection with a dock (Download, Send, Move, Move to trash, more). Item sheet: Open, Download / Download as ZIP (server-built ZIP with progress and cancel), Send, Share (viewer/editor), Rename, Move (folder picker), favorites, View details, Version history (download, restore, restore locally for backups), Disconnect backup, Remove from sync, Move to trash. Synced files are kept in the cloud and every device downloads changes from there; older files still held only on linked computers can be requested.
- **Search** stays on the current page as on the web: My Drive (with Search all files / Search this folder inside folders), Trash (deleted items), and in-place file results on every other page.
- **Shared:** Received | Sent transfer cards with status, per-file download, “Show more files”, Accept / Decline / Save to My Drive / Cancel transfer (with confirmations), paging, and the Shared access list with Remove access.
- **Sync on this phone:** a port of the desktop sync engine (`apps/desktop/src/sync.ts`, `backups.ts`, `sync-receipts.ts`) in `SyncEngine.kt`, `SyncBackups.kt`, `SyncReceipts.kt`, `SyncTransfers.kt` and `SyncJournal.kt`. The phone registers as a sync device (`POST /v1/sync/devices/register`) and publishes its folders with `PUT /v1/sync/folders`, so sync status shows when it is up to date. Synced files stay in the cloud. Two-way sync of folders chosen with the system folder picker (Storage Access Framework, persisted access): uploads and deletions of local changes, downloads, moves and deletions of remote changes from the change feed, full reconciles, conflict copies (`name (Conflict - device - id).ext`), kept copies of folders removed elsewhere, relay requests for files held on another device, delivery acknowledgements with a durable outbox and audits, checkpoints, retries with backoff and per-file/per-folder issues. Sync page: status, pause/resume all, Sync a folder (new cloud folder with numbered fallback, any My Drive folder, or a new folder inside one), per-folder pause, exclusions, change local folder, Stop syncing on this phone, Remove from sync everywhere, problems with Retry / Mark reviewed, recent activity, files waiting for another device, sync invitations (invite and remove people, accept into a local folder, decline) and “Sync to this phone” for folders synced on other devices (also in the My Drive item menu).
- **Backups:** folder list with status, folder detail with Files & versions (browser, per-file versions with Restore and Download) and History (restores and runs with their files), Stop backing up and Remove from Backups. **Back up a folder** from the phone: automatic runs once files have been unchanged for an hour, Back up now, pause/resume, exclusions, Archive (a final full backup, then removal of only the local files whose content matches the saved version) and Restore archived folder, Disconnect, and restores requested from other devices are applied to the local folder. These controls appear only for folders backed up from this phone.
- **Trash:** search, item count, Empty Trash, list/grid, Restore / Delete permanently per item or for a selection, paging.
- **Devices, Storage, Notifications, Settings:** device list with Revoke; storage usage and plan; notifications with Mark read; appearance (Light/Dark/System, Harbor/Ocean/Forest/Violet/Sunset presets, custom colors per mode with hex input and swatch picker, saved to the account automatically), profile (display name, username), Manage devices, Sign out, Delete account.
- **Files on the phone:** verified downloads (size and SHA-256), preview sheet with inline image/text preview, open in another app, share, and Download to the public Downloads folder (Android 9 and earlier choose a location). Multipart uploads with retries, renewed signed URLs and reservation cleanup.

Manual uploads and downloads run while the app remains open. They do not resume across process death; unfinished server reservations use the backend's expiry cleanup. Pausing an upload restarts that file from the beginning when resumed. Previews are private temporary files removed on the next launch.

Sync and backups run while the app process is alive (server checks every 2 s backing off to 30 s, local folders rescanned every 5 s on screen and every minute otherwise) and as a WorkManager periodic job about every 15 minutes with a network connection. Android decides when background work actually runs: Doze, battery saver and app standby buckets can defer it for hours, and a single background pass is limited to about 10 minutes. Interrupted uploads and downloads resume from the journal (multipart upload state, `.harbor-part` files verified by size and SHA-256). Limits compared with desktop: there is no file watcher, so local changes are found by comparing each folder with its previous scan; there are no live-update connections, so remote changes arrive by polling; transfers are sequential rather than four-way parallel; an archived backup keeps its (empty) top folder so the folder grant survives for a restore; and the sync journal is per account in the app's private storage, so uninstalling the app forgets mappings (local files are kept and reconciled when a folder is set up again).

Not included: offline browsing of cloud-only files, an Android DocumentsProvider, a receive-share extension, system push notifications, drag-and-drop uploads, and opening the local copy of a conflict in another app.

## Tests

Quick client checks (the JVM tests include the sync rules — safe names, internal paths, conflict names, scan diffing, the one-hour backup rule, folder states — and resumable sync transfers against a mock server):

```sh
apps/android/gradlew -p apps/android :app:testDebugUnitTest :app:lintDebug
```

The real backend test is skipped unless the isolated-service runner enables it. To run all tests, start the repository's Docker services and one Android emulator or USB-debugging device, install repository npm dependencies, and run:

```sh
docker compose up -d
ANDROID_HOME="$HOME/Library/Android/sdk" node apps/android/test-android.mjs
```

Use `ANDROID_SERIAL` when more than one device is connected. The runner creates a unique local DynamoDB table and MinIO bucket, runs the real backend on port 18990 and the Android failure-injection fixture on port 18989, configures an adb reverse tunnel, and removes its backend processes, table and bucket afterward. It never uses production accounts or storage. After the tests it rebuilds the APK against production.

Reports are under `app/build/reports`; emulator screenshots are under `build/screenshots`. The UI test writes only its named `harbor0-*.png` screenshots to the test device's Downloads directory so they survive test-app removal.

Debug builds alone accept a build-time API override:

```sh
apps/android/gradlew -p apps/android :app:assembleDebug \
  -PharborApiUrl=http://10.0.2.2:8787
```

HTTPS is required outside emulator/loopback addresses (`10.0.2.2`, `127.0.0.1`, `localhost`). Release builds always use the production endpoint and reject all cleartext network traffic. Fixture code is outside the Android application sources and never packaged.

Geist and Geist Mono (SIL Open Font License, see [GEIST-LICENSE.txt](GEIST-LICENSE.txt)) are bundled in `app/src/main/res/font` as Latin-subset variable fonts converted from the repository's `@fontsource-variable` packages; other scripts fall back to the system font. After adding an icon name to `generate-icons.mjs`, run `node apps/android/generate-icons.mjs` to regenerate `Icons.kt`.

## Verified on 1 October 2026

After rebuilding the UI to the web phone layout: debug and unsigned release APKs built, lint reported no errors, and `test-android.mjs` passed all 19 tests (14 API/transfer, three appearance, one real backend integration test and one end-to-end emulator UI test covering sign-in, folders, the upload queue, preview/save, rename, favorites, trash, Sync and Backup locations, the Backups page, Shared, in-place search, presets and sign-out). Light and dark screenshots of every main screen against the local backend are in `build/screenshots` (`light-*.png`, `dark-*.png`).

## Verified on 30 September 2026

After the redesign to the web and desktop style: debug and unsigned release APKs built, lint reported no errors, and all 18 tests passed (13 API/transfer, three appearance, one real backend integration test and one end-to-end emulator UI test on Android 16 / API 36). Ten emulator screenshots were reviewed, covering sign-in, drive, backups and history, the download dialog, trash, settings, Ocean light and Violet dark.

## Verified on 28 September 2026

- Debug APK and optimized unsigned release APK built successfully; Android lint has no errors. Its remaining warnings suggest newer dependency versions and optional Kotlin shorthand.
- All **18 tests passed**: 13 API/transfer tests, three appearance tests, one real backend integration test and one end-to-end emulator UI test.
- The real backend integration test uploaded/downloaded a **65 MiB** file across the 64 MiB multipart boundary, compared SHA-256 hashes, persisted custom appearance, exercised trash/restore/empty, rotated a restored session and verified remote revocation.
- Android 16 / API 36 ARM64 emulator: invalid/valid sign-in, folder creation, retained tab paths, document-provider URI upload and save with byte comparison, download verification, trash/permanent-delete/restore, read-only backups and history, theme saving, Activity restart with encrypted-session restoration, and sign-out.
- Screenshots reviewed in Harbor light, Ocean light and Violet dark.

Physical-device testing, external file-viewer behavior, native picker interactions across third-party document providers, live production-account authentication and release signing remain to be checked before a public release.

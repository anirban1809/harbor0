# harbor0 for Android

Native Kotlin and Jetpack Compose app for Android 8.0 (API 26) and later. It follows the [iOS app](../ios/README.md) and uses the same deployed harbor0 API. No backend changes are needed.

## Run or install

Open this directory in Android Studio, let Gradle sync, choose an emulator or USB-connected phone, and run **app**. Sign in with an existing verified harbor0 account. Account creation opens the web app.

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

- Five bottom tabs: Drive, Sync, Backups, Trash and Settings. Each file area retains its folder path when switching tabs. Android Back returns through the folder hierarchy.
- Email/password sign-in with Android device registration, encrypted credentials backed by Android Keystore, token refresh/rotation, session restoration and remote sign-out. Credentials are isolated by API address and excluded from cloud backup and device transfer.
- Folder creation, paginated file lists, pull-to-refresh, upload from Android's document picker, and moving files/folders to Trash.
- Disk-backed upload snapshots, streaming SHA-256, multipart upload retries with renewed signed URLs, progress, cancellation and best-effort reservation cleanup.
- Streaming downloads with byte-count and SHA-256 verification before opening, sharing or saving. Android's file viewer/chooser opens supported files in installed applications; this app does not embed a document viewer.
- Synced folder/device status and requests for files held on the source computer. Backup files are read-only, with paginated run history.
- Trash restore, permanent deletion and empty-trash confirmations, with revision checks.
- Account storage usage, Harbor/Ocean/Forest/Violet/Sunset presets, System/Light/Dark appearance, and custom light/dark accent, background, card, navigation and border colors. Drafts preview locally, explicitly save to the account, and remain available for retry if saving fails.
- The web and desktop visual style: shared color tokens and theme presets, Geist type, lucide icons and a matching component kit (`Kit.kt`), with breadcrumbs, skeleton loading, status badges and retry states. Responsive centered content, Android font scaling and labeled actions. See [DESIGN.md](DESIGN.md).

Transfers run while the app remains open. They do not resume across process death; unfinished server reservations use the backend's expiry cleanup. Downloads remain private temporary files until saved/shared and are removed on the next app launch. Sync and scheduled backup automation continue to run on computers, not on the phone.

Not included in this first version: offline browsing, background transfer services, automatic phone-folder sync, an Android DocumentsProvider, a receive-share extension, notifications, transfer invitations, folder ZIP downloads, full account/device management, or Google Play publishing.

## Tests

Quick client checks:

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

## Verified on 30 September 2026

After the redesign to the web and desktop style: debug and unsigned release APKs built, lint reported no errors, and all 18 tests passed (13 API/transfer, three appearance, one real backend integration test and one end-to-end emulator UI test on Android 16 / API 36). Ten emulator screenshots were reviewed, covering sign-in, drive, backups and history, the download dialog, trash, settings, Ocean light and Violet dark.

## Verified on 28 September 2026

- Debug APK and optimized unsigned release APK built successfully; Android lint has no errors. Its remaining warnings suggest newer dependency versions and optional Kotlin shorthand.
- All **18 tests passed**: 13 API/transfer tests, three appearance tests, one real backend integration test and one end-to-end emulator UI test.
- The real backend integration test uploaded/downloaded a **65 MiB** file across the 64 MiB multipart boundary, compared SHA-256 hashes, persisted custom appearance, exercised trash/restore/empty, rotated a restored session and verified remote revocation.
- Android 16 / API 36 ARM64 emulator: invalid/valid sign-in, folder creation, retained tab paths, document-provider URI upload and save with byte comparison, download verification, trash/permanent-delete/restore, read-only backups and history, theme saving, Activity restart with encrypted-session restoration, and sign-out.
- Screenshots reviewed in Harbor light, Ocean light and Violet dark.

Physical-device testing, external file-viewer behavior, native picker interactions across third-party document providers, live production-account authentication and release signing remain to be checked before a public release.

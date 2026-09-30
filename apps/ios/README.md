# harbor0 for iOS

A native SwiftUI starting point for iPhone and iPad, using the existing Harbor0 API. Requires Xcode and iOS 17 or later; no CocoaPods or third-party Swift packages.

## Run

Open `Harbor0.xcodeproj`, select the **Harbor0** scheme and an iPhone simulator, then Run. The normal app connects to the deployed Harbor0 API. Sign in with an existing verified Harbor0 account; account creation opens the web app.

On this Mac, the development simulator is named **Harbor0 iPhone**. For a physical iPhone, select your Apple team under Signing & Capabilities, connect and trust the phone, enable Developer Mode when prompted, and choose it as the destination. Device signing and physical-device testing have not been configured by this project.

## Included

- Email/password sign-in with IOS device registration, Keychain storage, refresh rotation, session restoration and remote sign-out.
- Folder navigation, paginated listings, pull-to-refresh and new folders.
- Upload from the system Files picker, using a coordinated local snapshot, streaming SHA-256, disk-backed multipart uploads, retry of failed parts and abort cleanup.
- Downloads to a temporary file, byte-count and SHA-256 verification, native Quick Look preview, and sharing/saving to Files.
- Five persistent bottom tabs: Drive, Sync, Backups, Trash and Settings, with independent folder navigation.
- Synced folders with device status, read-only backup browsing and backup run history, plus trash restore/permanent-delete/empty actions.
- Account and storage usage, Harbor/Ocean/Forest/Violet/Sunset color schemes, System/Light/Dark appearance, and custom accent/background/card/navigation/border colors. Settings preview locally and save to the same account preference used by web and desktop.
- Dynamic Type and accessibility labels, selected tab/theme states, and native file previews.

Transfers currently run in the foreground. Keep the app open until they finish; cancellation releases the upload reservation when the server can be reached. Interrupted reservations also use the backend's existing expiry cleanup. Downloads are temporary until saved through the preview's share button. Files are not automatically synced to the phone.

This first version does not yet include background/resumable transfers across app launches, a Files provider, a share extension, offline browsing, push notifications, transfer invitations, folder ZIP downloads, or full account management. Drive excludes linked Sync/Backup roots; those have their own tabs. Sync and scheduled backup automation run on the source computers, not the phone.

## Test

Start the repository's local Docker services, then run from the repository root:

```sh
docker compose up -d
node apps/ios/test-ios.mjs
```

The runner creates its own temporary DynamoDB table and MinIO bucket, starts the real backend on loopback port 18988 and a failure-injection fixture on 18987, runs XCTest and XCUITest, then removes its test services and storage. It does not use production accounts or cloud storage. Override `HARBOR_IOS_DESTINATION` for another simulator. Additional arguments pass to `xcodebuild`, for example `-only-testing:Harbor0Tests`.

Tests cover credential persistence failure, invalid/expired sessions, offline restoration, query escaping, invalid filenames, multipart retry, checksum rejection, and a 65 MiB round trip through the real local API/storage. The UI scenario covers invalid credentials, sign-in, folder creation, tab navigation and retained folder locations, backup write restrictions and history, trash restore/delete, theme persistence after relaunch, light/dark styling, file preview and sign-out. Appearance tests cover custom overrides, unsaved drafts and retry after a failed save. The real backend round trip also verifies account appearance persistence and trash/restore/empty operations. Native Files picker upload and Save to Files still need hands-on checks on a physical device.

Debug builds accept `HARBOR_API_URL` in the launch environment for an HTTPS API or a loopback HTTP API. Release builds always use the production endpoint and keep default HTTPS transport security. Debug HTTP exceptions are limited to local networking. Fixtures are never built into the app.

## Verified on 28 September 2026

- Xcode 26.6, iOS 26.5 simulator, Apple Silicon Mac.
- All 16 tests passed: 14 client/appearance/transfer tests, one real backend integration test and one end-to-end UI test.
- The real backend test uploaded and downloaded a 65 MiB file through isolated local DynamoDB/MinIO services, verified its checksum, persisted a custom account theme, exercised trash/restore/empty, restored the Keychain session and verified remote session revocation. The runner removed its database, bucket and test processes afterward.
- Simulator build and unsigned Release build for physical iOS devices succeeded. Release configuration has no HTTP transport-security overrides.
- All five tabs, independent folder navigation, backup history/read-only browsing, trash restore/delete, theme persistence after relaunch, preview open/close and sign-out were exercised through native UI automation. Screenshots were reviewed in Harbor light, Ocean light and Violet dark. Physical-device signing, production-account authentication and native Files provider interactions still require device/user testing.

Xcode test results and screenshots are retained under the ignored `build/Logs/Test` directory. This is a development starter, not an App Store submission.

## Interface direction

See [DESIGN.md](DESIGN.md) for the interface plan. The app adapts the web/desktop workspace to native navigation and five fixed bottom tabs. Compact file rows, subtle borders and grouped surfaces use the account's selected palette. The tab strip uses the sidebar color, with a highlighted active destination. Ocean, Forest, Violet and Sunset use the same hex values as the web/desktop presets; Harbor adapts the neutral base palette for iOS. Custom colors compute contrasting text for readability.

```text
My Drive                          +
Cloud files
-----------------------------------
Folder icon  Documents            >
File icon    Welcome.txt           ↓
             44 bytes
-----------------------------------
Transfer status (when active)
Drive   Sync   Backups  Trash  Settings
```

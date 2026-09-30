# harbor0

A working cloud drive, authenticated file-transfer service, web client, and Electron desktop client built from the four supplied specifications.

**iOS starter:** A native SwiftUI client now lives in [`apps/ios`](apps/ios/README.md), with sign-in, folder browsing, uploads, and verified downloads. Open `apps/ios/Harbor0.xcodeproj` to run it in Xcode. See the iOS README for local tests and current limitations.

**Production stack:** DynamoDB for metadata, Cognito for accounts and authentication, API Gateway + Lambda for the backend, and private Cloudflare R2 for file bytes. The requested stack replaces the documents’ PostgreSQL/Prisma/Redis/NestJS suggestions. Source specifications are preserved in `docs/specs/`; implementation decisions and remaining work are in [the status document](docs/STATUS.md).

**Current deployment:** [Open harbor0](https://d1bpha1d51nhxy.cloudfront.net). The web app runs on private S3 behind CloudFront, connected to `HarborStorage` in AWS `us-east-1` and the private R2 `harbor-files` bucket in the US jurisdiction. Create a real Cognito account; the Alice/Bob development passwords apply only to the separate local emulator setup below. Cognito uses its AWS default email sender. Custom file-invitation emails are not configured. See [web deployment](docs/WEB-DEPLOYMENT.md) and [backend validation](docs/LIVE-VALIDATION.md).

## Run locally

Requirements: Node.js 24, npm, and Docker. All development services bind to loopback. No AWS or Cloudflare credentials are needed for local testing.

```sh
npm ci
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
docker compose up -d
npm run local:setup
npm run dev
```

In another terminal:

```sh
npm run dev:web
```

Open **http://localhost:3000**. Use `alice@example.test` or `bob@example.test`, password `Development-only-123!`. New local accounts use email verification code `123456`. Development authentication is intentionally confined to the loopback server; the Lambda entrypoint always uses Cognito. New development identities are held in memory and disappear when the API restarts. File metadata and bytes persist in Docker volumes.

If MinIO’s public registry is unavailable but the images are cached on this machine:

```sh
docker compose -f compose.yaml -f compose.local.yaml up -d
```

The cached-image override is for this machine; the main Compose file pins the release from Quay. Public MinIO pulls were denied during this task, so a fresh machine or CI runner may need registry access or an approved mirror for that image. MinIO is a development substitute only. Production uses R2.

To launch Electron against local development (the local API must already be running):

```sh
HARBOR_DEV_AUTH=true HARBOR_API_URL=http://127.0.0.1:8787 npm run dev:desktop
```

On macOS, the development launcher creates a locally signed **harbor0 Development** runtime so native notifications work. Allow its notifications in System Settings. The plain `electron .` runtime from npm has an unsealed signature and macOS rejects its notifications. **Settings → Desktop settings → Test notification** sends a real OS notification; **Notification settings** opens system preferences. Notification failures appear in the app instead of being silently discarded. Release builds also require a valid code signature.

To sign in against a deployed service, create `apps/desktop/.env.local` with `HARBOR_API_URL` set to its HTTPS address and `HARBOR_DEV_AUTH=false`, then run `npm run dev:desktop`. Enter your account email and password directly in the desktop app; no browser is required. See `apps/desktop/.env.example` for the settings. Desktop development launches load `.env` and then `.env.local` from `apps/desktop`; explicitly exported shell settings take precedence. Only desktop connection settings are loaded. After changing these settings, choose **Quit harbor0** from the tray menu before relaunching; closing the window only hides it.

You can sign out and sign into another account on the same computer, including in development builds. Each account keeps separate sync folders, queued work, and device settings. Signing back in restores that account’s workspace; local files remain on disk after sign-out. Choose different local folders for different accounts.

The desktop client requires an available OS keychain. On Linux, insecure `basic_text` storage is rejected. Choose a dedicated sync folder in **Sync status**, or choose an existing source folder in **Backups**. Automatic backups save new file versions after one hour without changes. **Back up now** includes recent edits immediately. The **Archives** tab browses folders and saved versions; **Backups** shows run history and the files covered by each run. **Restore/Export** tracks restores to the original local folder, which replace its current file when the source computer is online with backups running. Exporting a saved version is available on the web. Local deletions leave archived files intact. My Drive separates Cloud, Backup, and Sync into three file browsers on web and desktop. Connected backup folders are read-only, including while paused; only the source computer can append versions through a backup run. Disconnect a backup from its folder menu or the Backups page to stop backup work and make its existing folder editable in Cloud. Disconnecting keeps local files and archived versions.

## What works

- Cognito signup, email verification, login, password reset, refresh rotation, and per-session device revocation. Desktop production sign-in uses an in-app email/password form and the HTTPS authentication API. Passwords are never saved; refresh credentials are encrypted through the OS keychain.
- 100,000,000,000 bytes free, atomically enforced with upload reservations. No device count or consumer transfer allowance.
- Folder browsing, uploads, authenticated downloads, rename/move, favorites, metadata search, trash, recursive permanent deletion, and immutable version history.
- Choose **Download as ZIP** from a folder's actions menu on web or desktop. AWS Lambda prepares one ZIP in temporary R2 storage using bounded chunks, then the browser downloads that single file through its normal download manager. A cancellable preparation panel shows overall percentage, file count and bytes; the browser handles transfer progress and the Downloads destination. No browser ZIP construction, Blob buffering or File System Access API is required. Nested files, empty folders and Unicode names are preserved; content hashes are verified. The worker writes uncompressed ZIP64 records and checkpoints across Lambda invocations, including mid-file. Temporary archives expire after 24 hours and are cleaned up by maintenance jobs. ZIPs currently support up to 10,000 parts of 16 MiB (about 156 GiB including ZIP records). Desktop uses the same backend archive, then downloads it with checksum verification.
- Direct multipart uploads with persisted receipts, retry, pause/resume, cancellation, provider-side size verification, and streaming desktop SHA-256 checks.
- Send files/folders to an exact username or email; verified email claims invitations. Accept/decline/cancel, save without re-upload, and authenticated sharing.
- Desktop checks for incoming files, folders, and shared sync invitations every 10 seconds while signed in, including with the window hidden in the tray. Native notifications open the specific invitation with accept/reject controls. Shared sync invitations also appear in **Received**; accepting requires choosing a local folder. Notification history is kept per account across restarts. OS notifications must be enabled for harbor0; a fully quit app cannot receive alerts.
- Large folder manifests, staged saves, and recursive deletion processed as durable background jobs. Partial saves remain invisible; failed saves release reservations and references.
- **Two-way shared sync:** In desktop **Sync**, open a folder’s menu → **Share folder**, then invite an existing account by email or username. The recipient sees it under **Shared with you**, accepts, and chooses a local folder. Both accounts can add, edit, rename, and delete contents; conflicts are preserved. The owner manages access and supplies temporary storage. Revocation stops recipient sync while keeping local files. The backend is deployed; use desktop version 0.1.1 or later. See [shared sync](docs/SHARED-SYNC.md).
- Ordered sync changes, revision conflicts, idempotent operations, checkpoints, offline SQLite journal, filesystem watchers, selective folder exclusions, backups, and conflict preservation.
- Responsive web UI, text/image/video/audio previews on web and desktop, notifications, account settings, device management, and an isolated Electron renderer. Open a file or choose **Preview** from its actions menu; downloads remain available in the viewer. Text is rendered literally with a 1 MB preview limit; audio and video stream with native playback and seeking controls. Unsupported formats/codecs offer a download fallback.
- **Settings → Appearance** offers Harbor, Ocean, Forest, Violet, and Sunset presets, each with light and dark colors. The preset, light/dark/system mode, and custom colors save to the signed-in account and restore on web and desktop. Returning to an open app refreshes the account preference; failed saves remain visible with a retry option. Accounts without a saved preference start with Harbor and system mode.
- Each web workspace page has a dedicated URL: `/drive`, `/received`, `/sent`, `/shared`, `/recent`, `/favorites`, `/trash`, `/devices`, `/storage`, `/settings`, and `/notifications`. Account flows use `/login`, `/signup`, `/confirm`, `/forgot-password`, and `/reset-password`. Links support refresh and browser history; sign-in returns to the requested workspace page. The shared layout keeps transfers running between pages.
- Folder addresses use `/drive?folder=<folder-id>`. Refreshing, opening a copied link, and signing in restore that folder and its breadcrumbs. Folder IDs keep links stable when folders are renamed or moved.
- CDK infrastructure, generated OpenAPI/types, CI, unit tests, real local DynamoDB/S3 integration tests, Playwright browser flows, and desktop smoke/sync checks.

## Validate

```sh
npm run check                 # lint, TypeScript, unit/contract tests
npm run test:integration      # Docker services + local:setup required
npm run openapi               # regenerates docs/openapi.json and API types
npx playwright install chromium
npm run test:e2e              # API and web dev servers required
npm run test:sync             # real desktop sync engine against local backend
npm run test:desktop          # Electron launch / renderer security checks
npm run test:previews         # web dev server required; isolated web + Electron preview fixtures
npm run build
npm run infra:synth
npm run build:web-static      # isolated S3-ready export
npm run cloud:validate-hosting # live S3/CloudFront checks; .env.cloud required
npm run cloud:validate-web     # live browser checks at WEB_ORIGIN
```

Live R2 validation has passed against Cloudflare: two-part presigned upload, resume receipts, completion replay, HEAD, SHA-256 download equality, range requests, denied unsigned access, abort, and deletion. Cognito authentication/refresh, Lambda-to-R2 operations, DynamoDB metadata/quota, and the browser have also been exercised live. Inbox delivery and password-reset confirmation still require a test inbox. Windows/Linux installers remain untested. Local integration tests use DynamoDB Local and MinIO.

## Deploy

See [deployment instructions](docs/DEPLOYMENT.md) for R2 setup, bucket-scoped credentials, Secrets Manager, Cognito, SES, Lambda deployment, web configuration, and desktop packaging. The active cloud resource names and validation evidence are in [live validation](docs/LIVE-VALIDATION.md).

Normal file uploads and downloads go directly to storage. The ZIP worker reads file content in bounded ranges to assemble folder archives. Presigned upload URLs expire in 15 minutes, and download URLs in 5 minutes. An already issued signed URL remains usable until it expires; revocation prevents new URLs immediately.

Transfers expire after 30 days, including accepted transfers. Saving to Drive creates a durable copy charged to the recipient. A sender cannot evade storage capacity by sending content and repeatedly purging the source: pending deletion retains the sender’s counted version while their transfers need it, and finishes after cancellation/expiry. These retention decisions are documented in [architecture](docs/ARCHITECTURE.md).

## Repository

| Location              | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `apps/backend`        | Lambda API, Cognito/R2 adapters, DynamoDB transactions and workflows    |
| `apps/web`            | Next.js web UI and HTTP-only cookie session proxy                       |
| `apps/desktop`        | Electron main/preload/renderer, SQLite journal, sync and backup engines |
| `packages/contracts`  | Shared runtime schemas and domain types                                 |
| `packages/api-client` | Shared API client and generated OpenAPI path types                      |
| `infra`               | AWS CDK stack                                                           |
| `scripts`             | Local setup, builds, R2 provisioning, verification                      |
| `docs`                | API contract, architecture, deployment, implementation status           |

## Android app

The native Kotlin/Jetpack Compose Android app mirrors the iOS workspace with Drive, Sync, Backups, Trash and Settings. It connects to the existing deployed API and supports secure sign-in, multipart uploads, verified downloads, system file opening/sharing/saving, backup history and account appearance preferences.

Open `apps/android` in Android Studio, or run `apps/android/gradlew -p apps/android :app:assembleDebug` with JDK 17 and the Android SDK installed. See [Android setup, tests and limitations](apps/android/README.md).

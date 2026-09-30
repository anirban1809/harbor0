# Implementation status

This repository contains working applications and tested storage flows. It is not a claim that every production and platform acceptance criterion in the supplied design documents has been completed.

## Delivered and exercised locally

- Backend domain/authorization tests, atomic quota and revision races, upload completion replay, object retention, invitations, shares, sync feeds, large manifest workflows, staged rollback, and recursive deletion.
- Real DynamoDB Local transactions and presigned S3 multipart upload/download, including ranges and SHA-256 equality.
- Browser signup/verification, upload/download, send to an existing user, accept/save, and invite-before-signup flows.
- Electron startup, sandbox/context isolation/preload boundary; SQLite restart persistence; traversal/symlink rejection and conflict preservation.
- Desktop sync engine local upload, remote download and remote rename against the real local backend.
- Type checking, lint, production web/backend/desktop builds, and AWS CDK synthesis.

Latest local verification: 29 unit/contract/integration tests and two browser scenarios passed, plus the Electron launch and desktop sync checks. The dependency audit reported zero vulnerabilities.

## Live provider verification

- `HarborStorage` is deployed in `us-east-1`: API, registration and maintenance Lambda functions, API Gateway, DynamoDB, Cognito, scheduling, alarms, and failure queue. `HarborWeb` serves the static app from private S3 through [CloudFront](https://d1bpha1d51nhxy.cloudfront.net). The browser session gateway runs inside the existing API Lambda.
- The real Cloudflare R2 adapter passed ten checks in the supplied endpoint's US jurisdiction: both presigned multipart PUTs, ListParts, completion and HEAD size, completion replay, SHA-256 download equality, ranged GET, denied unsigned access, abort, and deletion. The temporary bucket was deleted after testing. Evidence is saved locally in `.cloud/r2-validation.json`.
- Live validation covers Cognito JWT/GetUser authentication, the unverified-email gate, rotating refresh tokens, DynamoDB idempotency/quota/sync feeds, Lambda-signed R2 upload/download, transfers, save, expiry, and maintenance deletion. The browser passed live login, protected cookie storage, upload/download integrity and logout. See [the live report](LIVE-VALIDATION.md) for exact evidence and limitations.
- The real `harbor-files` R2 bucket permits the CloudFront and localhost web origins and has a two-day incomplete-upload lifecycle. Its managed public URL is disabled and it has no custom domains.
- Nine live hosting checks and ten browser checks passed against the public CloudFront URL, including protected cookies, refresh rotation, CSRF rejection, upload/download integrity, private S3 access, and cache isolation. Lint, TypeScript, 32 unit/contract tests, and both normal/static web builds passed. See [web deployment evidence](WEB-DEPLOYMENT.md).

## Remaining live/platform validation

- Actual signup email receipt, user-entered verification codes, password-reset completion, and desktop hosted login with PKCE. Automated live fixtures use admin provisioning with suppressed emails; they do not replace these inbox/browser checks.
- Cognito uses the AWS default sender. A custom SES invitation sender is intentionally unconfigured; the Luminote identity is not used. Invitation jobs remain pending/retryable and cannot be reported as delivered.
- Maintenance Lambda execution and deletion were tested. Full alarm delivery, disaster recovery from point-in-time backup, and longer-term scheduled retention exercises remain operational validation.
- macOS/Windows/Linux packaging configuration. The app was launched on macOS; Windows/Linux installation and code signing have not been tested.
- Fresh CI runners depend on registry access to the Compose images. Public MinIO pulls were denied in this environment; local validation used the already-cached image through `compose.local.yaml`. The GitHub Actions workflow has been supplied but has not been run on GitHub.

## Deliberate limits and follow-up work

- Billing has a provider interface and tested idempotent storage entitlement application. No payment provider, checkout, subscription portal, or public billing webhook is connected. The UI clearly says additional capacity is not purchasable yet.
- Polling is the notification transport. WebSocket/SSE hints, mobile push, advanced abuse/fan-out detection, and an administrative console are not implemented.
- Shared editors can create and replace content under the owner’s quota, rename, move within authorized folders, and trash items. Two-way shared sync now has explicit invitations/acceptance, desktop local-folder selection, cross-account delivery receipts, conflict preservation, and owner revocation. The backend was deployed on 28 September 2026 and passed 12 live checks with separate Cognito accounts, real filesystem watchers, DynamoDB and R2. Desktop 0.1.1 is packaged for Apple Silicon macOS; it is unsigned and requires manual installation. See [shared sync](SHARED-SYNC.md).
- Search is cursor-paginated metadata filtering within a user partition. Directory order is normalized name; the Recent view sorts its current page by modification time. A dedicated global-recency/search index and the other server sorting choices remain work for very large drives.
- A browser restart requires reselecting the original file to resume an upload. Persisted upload metadata and server receipts avoid retransmitting completed parts. Ordinary browser downloads use the browser download manager; desktop downloads perform explicit final SHA-256 verification.
- Full-file SHA-256 is supplied by the authenticated uploading client. The backend verifies the actual R2 object size, not a reconstructed multipart SHA-256. R2 multipart ETags are not treated as SHA-256. A trusted independent large-file hashing pipeline remains a production hardening task.
- Desktop local renames are currently observed as create/delete operations; remote rename/move events preserve the local mapping. Native Finder/Explorer context menus, Files On-Demand placeholders, signed automatic updates, bandwidth controls, and a conflict-resolution dashboard are not included.
- Desktop folder recovery is conservative: a remotely deleted local folder is preserved beside its old location as `<name> (Recovered by harbor0 <timestamp>)` rather than recursively destroying possible unsynced work. Backup restore is through cloud browsing and native file downloads; a bulk restore wizard remains to be built.
- Desktop runs one account per local profile to avoid mixing sync roots between identities. Cross-account switching requires a separate OS profile.
- Versions and change history are retained until explicit deletion. Automatic version expiry, sync-feed compaction, reference-count reconciliation tooling, and a full disaster-recovery exercise remain operational work.
- The web client has list/grid views, individual metadata actions, multi-select sending, basic image/text previews, and keyboard shortcuts. Advanced sorting, command palette, virtualized lists, and rich media/PDF previews are not complete.
- The underlying API uses technical request/page limits and a 32-ancestor path safety bound. Large folders use background jobs; there is no product-level count or byte allowance for normal person-to-person transfers. Separate API requests can carry at most 40 selected roots each.

## Contract adaptations

- Decimal GB throughout: the free allowance is exactly 100,000,000,000 bytes.
- Opaque IDs (normally UUIDv4, deterministic hashes for staged copy records); numeric per-user sync sequence allocated transactionally.
- Root metadata uses `parentId: null`; routes address the virtual root as `root`.
- Cognito owns passwords, email verification and token rotation. No local password database or custom refresh-token hashing system is used in production.
- Added `preparationState`, `saveState`, `failure`, and optional manifest pagination to transfers. A staged save returns a job ID; clients refresh the transfer until completion. `TRANSFER_SAVED` tells desktop clients to reconcile metadata after activation.
- Large folder capture fails safely if the sender’s drive changes during preparation, rather than delivering an inconsistent snapshot.
- Transfer retention is 30 days. Accepted content must be saved to Drive to keep it beyond that date. Source deletion waits while the sender’s outgoing transfers pin the content; those bytes remain in the sender’s usage.
- Source documents are reference specifications, not instructions to use their suggested database or to deploy infrastructure without configuration.

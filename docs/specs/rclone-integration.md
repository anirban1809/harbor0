# rclone support

rclone is an open-source command-line tool, written in Go, that copies, syncs and mounts files across more than 70 storage services. Adding a `harbor0` backend to it lets people use harbor0 from Linux, NAS boxes (Synology, Unraid, TrueNAS), servers and scripts. None of these have a harbor0 client today, and the Windows app isn't ready.

## What exists today

- Every API route except the public ones needs a Cognito access token in `Authorization: Bearer`. `route()` (`api.ts:216`) also requires a registered device: `identity.deviceId` comes from the token's `origin_jti` (`auth.ts:175`) and is checked with `service.checkDevice`.
- Access tokens last one hour and are renewed with a refresh token. Several clients renewing the same refresh token at once is what caused the random web sign-outs. That's why web renewal moved to `/api/v1/auth/renew` behind a Web Lock.
- Uploads already go straight to R2 without passing through Lambda:
  1. `POST /v1/uploads` takes `uploadInput` (`contracts/index.ts:280`): `operationId`, `parentId`, `name`, `sizeBytes`, `contentHash`, and `driveItemId` + `baseRevision` when uploading a new version of an existing file.
  2. `POST /v1/uploads/:id/parts` signs up to 50 part URLs at a time.
  3. `POST /v1/uploads/:id/complete` finishes the upload.
- `POST /v1/downloads` returns a presigned R2 URL that lasts 5 minutes.
- Listings (`GET /v1/drive/folders/:id/children`) return `itemSchema` (`contracts/index.ts:128`). It has no content hash and no client modification time. The SHA-256 is stored only on the version (`versionSchema.contentHash`).
- Name comparison is case-insensitive after NFC normalization (`NAME#` claims). Versions are immutable and never expire, and every version counts toward quota.
- Backup roots make their whole cloud subtree read-only, except for the source device's backup-run routes.
- Rate limit: 600 requests per minute per user (`api.ts:245`).
- A bulk upload costs about 100 DynamoDB WCU per file.
- Device platforms are `WEB | MACOS | WINDOWS | LINUX | IOS | ANDROID` (`contracts/index.ts:52`).
- Feature flags (`flags.ts`) can limit a feature to chosen accounts.

## How it will work

1. In web Settings, the user opens **Use with rclone** and creates an access token with a name and an access level (full or read-only). The token appears once, together with a ready-to-paste command:
   ```
   rclone config create myharbor harbor0 token=h0_pat_…
   ```
2. rclone sends that token as `Authorization: Bearer` on every request. There's no refresh flow and no signing in again.
3. The token shows up on the Devices page as "rclone · <name>", with its last-seen time. Signing that device out or deleting the token revokes it immediately.
4. All the normal rclone commands work against `myharbor:`: `ls`, `copy`, `sync`, `bisync`, `check`, `mount`, `serve`, and transfers to and from other services, for example `rclone sync gdrive:Photos myharbor:Photos`.

## Phase 1: Personal access tokens (backend)

### Token format

- The token is `h0_pat_` followed by 32 random bytes in base64url. The prefix lets `route()` tell a token from a Cognito JWT without parsing it. It also lets GitHub secret scanning recognise leaked tokens; we'd register the pattern later.
- Only `sha256(token)` is stored, never the token itself.

### Data model (single table)

| Row (pk / sk) | Fields | TTL |
| --- | --- | --- |
| `PAT#<sha256(token)>` / `PAT` | `userId`, `deviceId`, `scope` (`FULL` \| `READ`), `createdAt`, `expiresAt`, `revokedAt` | `expiresAt` + 30 days |
| `USER#<id>` / `PAT#<deviceId>` | `name`, `tokenHash`, `scope`, `createdAt`, `expiresAt`, `lastUsedAt` (for the Settings list) | same |
| Device row (existing) | new device per token, `platform: 'CLI'`, `appVersion` from the `User-Agent` (`rclone/v1.71.0`) | — |

- Add `CLI` to the `platform` enum. The change is additive, but Android and iOS must show unknown platforms with a generic icon.
- Each token has its own device id, so the existing device check, sign-out and per-device audit trail all apply without changes.
- Expiry choices: 30 days, 90 days, 1 year, or never. The default is 1 year.
- A user can have at most 20 active tokens.

### Authentication

- In `route()`: when the bearer value starts with `h0_pat_`, call a new `auth.patIdentity(token)` instead of the Cognito one.
  - It looks up `PAT#<hash>` and rejects the token if it's revoked or expired.
  - It loads the Cognito user's attributes, using the same cache as `identity()`, so disabled and deleted accounts are still rejected.
  - It returns an `Identity` with `deviceId` set to the token's device and `sessionId: pat:<deviceId>`.
- Update `lastUsedAt` and the device's `lastSeenAt` at most once per hour per token, to keep DynamoDB writes down.
- `READ` tokens: reject any non-GET route, except `POST /v1/downloads` and `POST /v1/folder-downloads`, with `403 TOKEN_SCOPE`. Add a `readOnlySafe` flag to the route `Definition` so these exceptions are explicit.
- These routes must never accept a token: anything under `/v1/auth/*`, `/v1/users/me/delete`, two-factor setup, token management itself, and billing. Mark them `sessionOnly` in the route definition.

### Routes (Cognito session only)

| Route | Does |
| --- | --- |
| `GET /v1/tokens` | List the user's tokens: name, scope, created, expires, last used. Never the token itself. |
| `POST /v1/tokens {name, scope, expiresInDays}` | Create the device and both PAT rows in one transaction. Returns the token once. |
| `DELETE /v1/tokens/:deviceId` | Revoke the token (sets `revokedAt`) and remove the device |

- `DELETE /v1/devices/:id` and `POST /v1/devices/:id/sign-out` on a `CLI` device also revoke its token.
- Account deletion revokes all tokens.

### Rate limits

- Tokens get their own bucket, `pat:<deviceId>`, at 300 per minute. That leaves the account's other clients room within the shared 600-per-minute user limit.
- Daily upload limit per account for token clients: start at 20,000 files per day. Return `429 RATE_LIMITED` with `Retry-After`. This keeps a NAS bulk import from running up the DynamoDB bill unnoticed. Show the remaining amount in the Settings page.

## Phase 2: API changes rclone needs

All of these are additive and optional, so existing clients aren't affected.

1. **Modification time.**
   - Add optional `modifiedAt` (ISO time) to `uploadInput`.
   - Store it on the version and copy it to the item as `modifiedAt`.
   - Add `PATCH /v1/drive/items/:id/modified {modifiedAt, baseRevision}` so rclone can change a file's modification time without uploading it again. This is rclone's `SetModTime`.
   - Without this, rclone falls back to comparing sizes only, unless the user passes `--checksum`.
2. **Hash in listings.** Add `contentHash` (from the current version) to `itemSchema`. `rclone check` and `--checksum` can then compare files without one request per file.
   - Check whether the current-version fields are already on the ITEM row. If they aren't, write them on new uploads and backfill old items with a versioned job. The data model rules require this.
3. **Path lookup.** Add `GET /v1/drive/resolve?path=/a/b/c`, which returns the item for that path, or `404` along with the deepest folder that does exist. rclone's `dircache` works without it, but with it, `rclone copy file myharbor:deep/path/` costs one request instead of one per level.
4. **Server-side copy.** Check whether `cloud-copies.ts` can be exposed as `POST /v1/drive/items/:id/copy {parentId, name}`. If it can, rclone's `Copy` won't need to download and upload again. Otherwise leave server-side copy out of the first version.
5. **Error codes.** Every error rclone has to handle needs a stable `code` in the error body:
   - `QUOTA_EXCEEDED` → rclone `fserrors.FatalError`
   - backup-root read-only errors → `fs.ErrorPermissionDenied` (also not retried)
   - `NAME_CONFLICT` → handled by the backend
   - `RATE_LIMITED`, 5xx → retry with backoff, using `Retry-After`

Regenerate `docs/openapi.json` and `packages/api-client/src/generated.ts`. CI fails if the OpenAPI output is out of date.

## Phase 3: The rclone backend (Go)

This is a new package, `backend/harbor0`, written to rclone's conventions and modelled on the `pcloud` and `onedrive` backends, which also address files by ID.

### Config options

| Option | Notes |
| --- | --- |
| `token` | Personal access token (required, stored obscured like other rclone secrets) |
| `endpoint` | Defaults to `https://api.harbor0.com`. Advanced option, for staging. |
| `chunk_size` | Multipart part size. Default 16 MiB, and it must keep files within 10,000 parts. |
| `upload_concurrency` | Parts uploaded at the same time. Default 4. |
| `hard_delete` | Delete files permanently instead of moving them to trash. Default `false`. |
| `encoding` | rclone's standard `lib/encoder` setting for characters harbor0 doesn't allow in names |

### How each rclone operation maps to the API

| rclone | harbor0 |
| --- | --- |
| path → ID | `lib/dircache` + `/v1/drive/resolve` (or walking `children`) |
| `List` | `GET /v1/drive/folders/:id/children` (paged by `nextCursor`) |
| `NewObject` | dircache lookup + `GET /v1/drive/items/:id` |
| `Put` | `POST /v1/uploads` (new file) → parts → PUT to presigned URLs → `complete` |
| `Update` | same, with `driveItemId` + `baseRevision` so the upload becomes a new version |
| `Open` | `POST /v1/downloads` → GET the presigned URL. Supports `Range`, and fetches a new URL when one expires during a long read. |
| `Mkdir` / `Rmdir` | `POST /v1/drive/folders` / trash the empty folder |
| `Remove` | trash, or `/permanent` when `hard_delete` is set |
| `Move` / `DirMove` | `POST /v1/drive/items/:id/move` (also renames) |
| `Copy` | `/v1/drive/items/:id/copy`, if Phase 2 item 4 ships |
| `Purge` / `CleanUp` | trash the folder / `POST /v1/drive/trash/empty` |
| `About` | `GET /v1/drive/usage` (total, used, trashed, free) |
| `Hashes` | `hash.SHA256` |
| `ModTime` / `SetModTime` | `modifiedAt` / `PATCH …/modified`. Precision 1 ms. |
| `ChangeNotify` (for `mount`) | poll `GET /v1/sync/changes` from a checkpoint, at most once a minute |
| `PublicLink` | not supported (harbor0 has no public links) |

### Details

- Features to declare: `CaseInsensitive: true`, `CanHaveEmptyDirectories: true`, `ReadMimeType` / `WriteMimeType: true`, `DuplicateFiles: false`.
- Names are normalized to NFC before upload, so names that look different but compare equal fail clearly instead of being renamed silently.
- **Upload contents:** `uploadInput.contentHash` is optional, but `complete` requires it. Compute the SHA-256 while streaming the parts, so uploading from another service (gdrive → harbor0) doesn't download the file twice.
- **Operation IDs:** each logical operation gets one `operationId`, which is reused on retry so a retried mutation isn't applied twice.
- **Interrupted uploads:** `DELETE /v1/uploads/:id` on failure releases the reserved quota. Abandoned uploads are cleaned up by the server's existing expiry job.
- **Requests:** go through `lib/rest` + `lib/pacer`, with `User-Agent: rclone/<version>`.
- **Sync folders:** files that rclone writes into a sync folder reach the user's devices the same way web uploads do. Nothing special is needed.

### Tests

- Run rclone's own test suites against a staging account: `go test ./backend/harbor0 -remote TestHarbor0:` (`fstests`), plus `fstest/test_all` with `vfs` and `mount`.
- Run the backend's unit tests against a fake API (`httptest`). These cover the error mapping, renewing expired download URLs, and resuming uploads.

## Phase 4: Distribution

### 4a. harbor0 build of rclone (beta)

- Public repo `harbor0/rclone`: a fork that adds only `backend/harbor0`. A GitHub Action rebases it onto each upstream release tag (`v1.x.y`) and opens a pull request when the rebase conflicts.
- Builds with goreleaser for:
  - linux amd64, arm64 and armv7
  - darwin universal, signed and notarized
  - windows amd64 and arm64, signed
- Releases are versioned `v1.x.y-harbor0.N`.
- Published through:
  - GitHub Releases
  - a Homebrew tap: `brew install harbor0/tap/rclone`, which is marked `conflicts_with "rclone"`
  - an install script on harbor0.com
  - a Docker image `ghcr.io/harbor0/rclone`
- The binary is named `rclone`, so existing scripts, cron jobs and GUIs keep working. It's a complete rclone, so the user's other remotes and `rclone.conf` work exactly as before.
- Docs say clearly that installing this build replaces the official rclone and is temporary until the backend is in official rclone.

### 4b. Upstream (general availability)

- Open the backend as a pull request to `rclone/rclone` once Phase 2 is live in production and the beta has run for at least 4 weeks without API changes.
- The pull request includes:
  - `backend/harbor0`
  - the line in `backend/all/all.go`
  - `docs/content/harbor0.md`
  - the README and overview-table entries
  - `fstest/test_all/config.yaml` entries
- Give the rclone project a free test account that never expires, and list a harbor0 engineer as the backend's maintainer.
- After the release that includes it, archive the fork and point the tap, script and Docker image at the official rclone.

### API compatibility

Released binaries keep running for years. Rules for the API from here on:

- Routes the backend uses don't change shape within `/v1`.
- The backend logs warnings on unknown fields instead of failing.
- The server records the version from each token client's `User-Agent`. If a release turns out to be broken, it can return a clear error to that version only (`426 CLIENT_TOO_OLD`, "update rclone").

## Phase 5: Web and admin

- Web Settings → **Use with rclone**:
  - token list (name, access level, created, expires, last used, revoke)
  - create dialog
  - show the token once, with a copy button and the `rclone config create` command
  - install instructions for each OS
  - today's upload allowance
- Devices page: icon and label for `CLI` devices. Desktop, iOS and Android show `CLI` devices with a generic icon.
- Feature flag `rclone`:
  - When off, the Settings section is hidden and `POST /v1/tokens` returns `403 FEATURE_DISABLED`.
  - Tokens that already exist keep working when the flag is turned off. To cut access, revoke the tokens.
- Admin console:
  - per-user token count and last use, with revoke (audit-logged)
  - token client versions seen in the last 30 days
  - daily upload counts against the limit

## Phase 6: Tests and rollout

Backend tests:

- Only token hashes are stored. A revoked or expired token is rejected right away, even if the identity cache still holds it.
- `READ` tokens can list and download but can't make any change.
- `sessionOnly` routes reject tokens.
- Signing out a `CLI` device revokes its token, and account deletion revokes all tokens.
- The token and daily-upload limits apply.
- A `modifiedAt` sent with an upload round-trips, and `PATCH …/modified` checks `baseRevision`.
- `contentHash` appears in listings, including for old items after the backfill.
- Writes into a backup root fail with the permission error code.

Rollout:

1. Phase 1 and 2 to staging. Run the rclone integration tests against staging.
2. Production with the `rclone` flag on for internal accounts, then for beta users who ask for it.
3. Publish the fork builds. Watch DynamoDB write costs and the daily upload limit for 2–4 weeks.
4. Upstream pull request (Phase 4b).

## Later

- `rclone serve`-style WebDAV gateway for mounting harbor0 in Finder or Explorer without rclone. This needs a non-Lambda service in the data path, so it's out of scope here.
- Tokens limited to one folder (for example, a NAS that may only write to `Backups/NAS`).
- E2EE: once per-account encryption ships, the backend must implement harbor0's encryption itself, or refuse encrypted accounts with a clear error. `rclone crypt` on top works today, but harbor0's apps can't read files encrypted that way.

## Open decisions

- Default token expiry: 1 year, or 90 days? Allow "never"?
- Daily upload limit for token clients: 20,000 files per day? Lower during the beta?
- Should overwriting a file from rclone keep every version (today's rule, which uses quota), or should token clients be able to replace the latest version? Users running `rclone sync` on files that change often will fill their quota.
- Should the fork binary be named `rclone` (scripts keep working, but it replaces the official one) or `rclone-harbor0` (installs alongside it)? This spec assumes `rclone`.
- `hard_delete` default: trash (safer, but uses quota until the trash is emptied) or permanent delete (what most rclone backends do)?

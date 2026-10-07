# WebDAV access to My Drive

## Why

WebDAV lets people mount harbor0 as a network drive without a harbor0 app. Finder (Connect to Server), Windows (Map Network Drive), GNOME/KDE, iOS Files, rclone, Cyberduck, and the many apps that sync over WebDAV (Obsidian, Joplin, Zotero, NAS backup tools) all speak it. It covers Linux, and Windows until the Windows app is ready.

Scope: the account's own My Drive tree. Not Trash, transfers, Shared with me, or version history.

## What exists today

- Items are addressed by id. Paths resolve one segment at a time through the `NAME#<parent>#<normalized>` claims (`domain.ts:55`). Names compare as NFC + lowercase, so the WebDAV server is case-insensitive like Finder and Windows.
- Listing: `list(userId, parentId, limit, cursor)` (`domain.ts:549`). Metadata: `metadata()` (`domain.ts:733`).
- Changes: `createFolder()` (`domain.ts:517`), `mutate()` with `name`, `parentId` or `action: 'trash'` (`domain.ts:581`). All writes take an `operationId` and `baseRevision`.
- Uploads: `createUpload()` reserves quota and opens an R2 multipart upload (`domain.ts:806`), then `uploadParts()` and `completeUpload(…, parts, contentHash)` (`domain.ts:998`). The client declares SHA-256. An upload to an existing name becomes a new immutable version.
- Downloads: `download()` returns a presigned R2 URL valid for 5 minutes (`domain.ts:1471`).
- Backup roots make their whole subtree read-only.
- There is no "copy a Drive item" operation yet. `cloud-copies.ts` only handles saving transfers.
- Auth is Cognito JWTs plus signed device identity. Feature flags live in `packages/contracts/src/flags.ts` and are enforced by `flagged()`.
- The API is an API Gateway `HttpApi` (`infra/app.ts:442`) with a 10 MB payload limit and a 29 s timeout. Lambda accepts at most 6 MB.

## How it will work

1. In web Settings, under **Connect apps (WebDAV)**, the user creates an app password named after its device, e.g. "Work laptop – Finder". It is shown once.
2. They connect a client to `https://dav.harbor0.com/` with their username and that app password.
3. They see My Drive as folders and files. They can open, save, create folders, rename, move, and delete (to Trash). Overwriting a file adds a version.
4. They can revoke the app password from Settings at any time. Its last-used time and client are shown there.

## Architecture

WebDAV clients `PUT` whole files in one request and can't use presigned multipart parts, so bytes can't flow through API Gateway or Lambda.

- **New service `apps/webdav`.** A long-running Node 24 HTTP server (plain `node:http` or Hono on `@hono/node-server`). It imports `StorageService` from `@harbor/backend` directly and talks to DynamoDB and R2 with the same code paths as the API. No business logic is duplicated.
- **Hosting:** to be decided (see open decisions). The candidates are ECS Fargate in `us-east-1`, near DynamoDB, or a host outside AWS, near R2, so proxied downloads don't pay AWS egress (about $0.09/GB vs free from R2). The service starts with one small task (0.25–0.5 vCPU) and must be stateless enough to run two.
- **Domain:** `dav.harbor0.com`, TLS required. Windows refuses Basic auth over plain HTTP.
- **Staging:** `dav.staging…`, following the `HARBOR_ENV` pattern and `*Staging` stacks.

## Phase 1: App passwords

| Row (pk / sk) | Fields |
| --- | --- |
| `USER#<id>` / `APPPW#<id>` | `name`, `prefix` (first 6 chars, for display), `createdAt`, `lastUsedAt`, `lastClient` (User-Agent), `scope: 'READ' \| 'WRITE'`, `revokedAt` |
| `APPPW#<sha256(secret)>` / `KEY` | `userId`, `passwordId` (lookup by secret) |

- The secret is 24 random bytes in base32, shown grouped like `abcd-efgh-…`. Only the hash is stored. SHA-256 is enough because the secret has full entropy, so no Argon2 is needed.
- Basic auth username: the harbor0 username or email. It must match the secret's owner; a mismatch counts as a failure.
- Routes: `GET/POST /v1/users/me/app-passwords` and `DELETE /v1/users/me/app-passwords/:id`. They need a fresh web session, not an app password. Each account can have at most 20.
- Revoking writes `revokedAt`. The WebDAV server caches valid secrets for at most 60 s.
- An app password can never call the JSON API, change account settings or create other app passwords.
- Deleting the account, or "sign out everywhere" (`signOutAll`), revokes all app passwords.
- Brute force: rate-limit failures per IP and per username with the existing conditional-update `rateLimit`. After 10 failures in 10 minutes, return `429` for that pair.
- Add the contracts, regenerate `docs/openapi.json` and `generated.ts`, and add a web Settings section that lists, creates (show once + copy) and revokes app passwords, with connection instructions per OS.

## Phase 2: Read-only server (class 1)

| Method | Behaviour |
| --- | --- |
| `OPTIONS` | `DAV: 1, 2` (2 only once LOCK ships), `Allow:` header |
| `PROPFIND` depth 0/1 | Resolves the path and lists through `list()`. Returns `displayname`, `getcontentlength`, `getlastmodified`, `creationdate`, `getetag` (version id), `getcontenttype`, `resourcetype`, `quota-available-bytes`, `quota-used-bytes`. `Depth: infinity` returns `403` with `propfind-finite-depth`. |
| `GET` / `HEAD` | Resolves the path to the current version, then streams from R2 via the presigned URL. Supports `Range` and `If-None-Match`. |

- **Path cache:** an in-memory LRU of `(userId, parentId, normalizedName) → item`, with a 5–10 s TTL. Writes from this server invalidate it. Clients send dozens of `PROPFIND`s for one Finder window, and this keeps those to a few DynamoDB reads.
- **Hidden in listings:** Trash, items under an emptied trash, and in-progress uploads.
- **Backup roots** appear as normal read-only folders. Finder shows a lock badge when it gets `403` on write.
- **Flag:** add `webdav` to `featureFlags`. The server checks `flagged()` per account, the Settings section only shows when the flag is on, and before the flag is on the server returns `403`.
- **E2EE accounts:** return `403` with the body "WebDAV isn't available for end-to-end encrypted accounts", and hide the Settings section. See "E2EE" below.

## Phase 3: Writes

| Method | Maps to |
| --- | --- |
| `PUT` | New file, or a new version of an existing one. Uses a new `StorageService.streamUpload()` (see below). Honours `If-Match` / `If-None-Match: *`. |
| `MKCOL` | `createFolder()`. Returns `405` if the name exists and `409` if the parent is missing. |
| `DELETE` | `mutate(action: 'trash')`. Never permanent. |
| `MOVE` | `mutate(name, parentId)`. Supports `Overwrite: T`, which trashes the target first in the same transaction where possible, and `Overwrite: F`. |
| `COPY` | New domain operation `copyItem()`. Files reuse the `OBJECT` refcount, so no bytes are copied. Folders run as a `JOB`, like the ZIP worker. Until it exists, return `501`. |
| `PROPPATCH` | Accept and ignore with `200` multistatus, except `Win32LastModifiedTime` / `getlastmodified`, which can set the client mtime if items gain that field. |

**`streamUpload()`**, new in `domain.ts`:

1. Get the size from `Content-Length`, falling back to `X-Expected-Entity-Length` (Finder sends `Transfer-Encoding: chunked`).
2. If neither header is present, reserve against remaining quota with a cap (open decision) and correct the reservation at commit.
3. `createUpload()`, then cut the body into 16 MiB parts and upload them to R2 with bounded concurrency (2–4), while hashing SHA-256 as the bytes pass through.
4. `completeUpload()` with the computed hash.
5. If the client disconnects, call `abortUpload()` (`domain.ts:1273`). R2's 2-day lifecycle catches anything missed.

Other write rules:

- **Junk files:** silently accept and discard `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini` and `~$*` lock files. `PUT` returns `201` and `PROPFIND` does not list them. Keep them in a short-lived in-memory set per user so the client sees them for 60 s.
- **Atomic saves:** apps save as write-temp-then-`MOVE`-over-original. Map `MOVE` onto an existing file to "new version of the target from the temp item's object", so history stays on one item instead of the original being trashed. Add this as a domain op.
- **Write cost:** each `PUT` costs about 100 WCU (see the DynamoDB write-cost note). Junk filtering and the atomic-save mapping are the main levers. Measure WCU per WebDAV `PUT` before widening the flag.
- **Errors:** quota exhausted → `507 Insufficient Storage`; backup root → `403`; name conflict → `409` / `412`; invalid names (`/`, control chars, reserved Windows names if the Drive rejects them) → `400`.

## Phase 4: Locks (class 2)

Finder mounts read-only unless the server advertises class 2.

- `LOCK` / `UNLOCK` store `USER#<id>` / `DAVLOCK#<itemId|path>` with token, owner, depth and expiry (default 10 min, max 1 h), using the DynamoDB TTL attribute.
- Exclusive write locks only. Shared locks return `423`/`412` as appropriate. Lock-null resources (locking a name that doesn't exist yet) create an empty placeholder that disappears if never written.
- Only WebDAV writes check locks. The web, desktop and mobile apps ignore them; they are advisory.

## Phase 5: Tests and rollout

- **Unit tests** against the in-memory repo for path resolution, `streamUpload` (chunked, abort, quota), `MOVE` overwrite and atomic save, and junk filtering.
- **Protocol tests:** the `litmus` WebDAV suite in CI against the local server (MinIO + local Dynamo), with a recorded expected-failure list.
- **Manual matrix**, recorded in `docs/LIVE-VALIDATION.md`: macOS Finder, Windows 11 Explorer, iOS Files, GNOME Files, rclone, Cyberduck, and Obsidian/Joplin. Check large files (5 GB), unicode names, rename case-only, a backup root, and quota-full.
- **Local:** `npm run dev:webdav` uses DEV_AUTH, where an app password is the dev token.
- **Rollout:** turn the `webdav` flag on for the user's own account, then beta wave 1, then everyone. Add an alarm for 5xx rate and p95 `PUT` latency, using the existing SNS `Alerts` topic.

## E2EE

The cloud server must see plaintext, so it can't serve E2EE accounts, and those accounts stay `403`. Later, WebDAV for E2EE accounts can be a local bridge in the desktop app: a loopback-only server (`127.0.0.1`, random per-session password, `Host` header check against DNS rebinding) that decrypts with the device's key. Serving ciphertext to E2EE-aware clients (an rclone backend) waits until the encryption format is stable. Decrypting on the server with a user-supplied key is ruled out.

## Open decisions

1. **Hosting:** Fargate in `us-east-1` (simplest, AWS egress on downloads) vs a host near R2 (cheaper egress, second platform to run).
2. **`GET` redirects:** whether to `302` to presigned R2 for clients known to follow redirects (rclone, Cyberduck) to save egress, or always proxy.
3. **App password scope:** whole drive, read/write only, or also allow limiting to one folder (useful for Obsidian/Zotero).
4. **Chunked `PUT` without a size hint:** reservation cap, e.g. min(remaining quota, 5 GB).
5. **Shared with me:** whether to expose received shares as a read-only `/Shared with me` folder later.
6. **Plan:** whether WebDAV is free for everyone after the beta or a paid feature.

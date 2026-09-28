# Codex Prompt — Shared API and Database Contract

## Purpose

This document is the canonical shared contract for the cloud-storage product.

It must be treated as the source of truth by:

- the backend;
- the web application;
- the Electron desktop application;
- future mobile applications.

The purpose of this contract is to prevent implementation drift between separate clients and backend services.

Do not duplicate incompatible interpretations of entities, states, API behavior, sync semantics, or transfer behavior in individual repositories.

If implementation details conflict with this document, update this contract deliberately and propagate the change to all clients.

---

# Product Definition

The product is a consumer cloud-storage, backup, sync, and authenticated person-to-person file-transfer service.

Core commercial model:

- Every account gets **100 GB of storage for free**.
- Users pay only for additional storage capacity.
- Backup is included for free.
- Sync is included for free.
- Multi-device use is included for free.
- Person-to-person file transfers are included for free.
- There are no consumer-facing transfer quotas.
- There are no consumer-facing device limits.
- There is no anonymous sharing.
- Every recipient must authenticate before accessing transferred or shared content.
- A transfer may be addressed to an email address that does not yet belong to an account.
- The recipient must create and verify an account before receiving such a transfer.
- Transfers happen entirely over the internet.
- Nearby discovery is out of scope.
- AI inspection or semantic analysis of private files is out of scope.
- Mobile clients will be added later.

The first clients are:

- Web application.
- Electron desktop application for macOS, Windows, and Linux.

---

# Architectural Principle

The database owns logical filesystem state.

Object storage owns file bytes.

Do not infer the user's directory structure from object-storage keys.

Conceptually:

```text
PostgreSQL
    |
    |-- user identity
    |-- devices
    |-- folders
    |-- filenames
    |-- revisions
    |-- permissions
    |-- transfers
    |-- shares
    |-- sync sequence
    |-- quota
    |
Object Storage
    |
    |-- immutable file-content objects
```

Logical file metadata and physical file content must remain distinct.

---

# Identifier Conventions

Use opaque globally unique identifiers.

Recommended:

```text
UUIDv7
```

or another sortable collision-resistant identifier.

Never expose sequential database IDs.

All primary entities should use strings in API responses.

Example:

```json
{
  "id": "0192f57c-3f80-7f12-9d42-6cd1f52b5b31"
}
```

---

# Time Format

All API timestamps must be ISO 8601 UTC.

Example:

```text
2026-09-25T08:31:22.184Z
```

Database storage should use timezone-aware timestamps.

Clients are responsible for rendering timestamps in local time.

---

# Byte Counts

All file sizes, quota values, transferred bytes, and storage measurements must use integer bytes.

Do not use floating-point GB values internally.

Example:

```json
{
  "sizeBytes": 2147483648
}
```

Display formatting is a client concern.

---

# Authentication Model

Use short-lived access tokens and rotatable refresh sessions.

Authentication concepts:

```text
User
Session
Device
EmailVerificationToken
PasswordResetToken
```

The backend is authoritative.

Recommended access-token lifetime:

```text
5–15 minutes
```

Refresh sessions must be revocable.

---

# User Entity

Canonical representation:

```ts
type User = {
  id: string;
  email: string;
  emailVerified: boolean;

  username: string;
  displayName: string;
  avatarUrl: string | null;

  storageQuotaBytes: number;
  storageUsedBytes: number;
  storageReservedBytes: number;

  createdAt: string;
  updatedAt: string;
};
```

Rules:

- `email` must be unique after normalization.
- `username` must be unique case-insensitively.
- usernames are displayed with `@`, but `@` is not stored.
- usernames must have a stable normalized form.
- changing username should be rate-limited and auditable.
- `storageQuotaBytes` includes free + paid entitlement.
- `storageReservedBytes` represents in-progress upload reservations.
- available capacity is:

```text
storageQuotaBytes
- storageUsedBytes
- storageReservedBytes
```

---

# Username Rules

Initial recommendation:

```text
3–32 characters
```

Allowed:

```text
a-z
0-9
_
.
```

Rules:

- case-insensitive uniqueness;
- store normalized lowercase value;
- prevent reserved names;
- prevent misleading system-like names;
- do not allow whitespace;
- do not allow trailing dot;
- do not allow repeated dots if avoidable.

Example:

```text
@anirban
@rahul.s
@john_92
```

---

# Device Entity

Canonical representation:

```ts
type Device = {
  id: string;
  userId: string;

  name: string;
  platform:
    | "WEB"
    | "MACOS"
    | "WINDOWS"
    | "LINUX"
    | "IOS"
    | "ANDROID";

  appVersion: string | null;
  devicePublicId: string | null;

  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};
```

Rules:

- web sessions may have a `Device` record.
- desktop installs must have a stable `devicePublicId`.
- revocation invalidates associated refresh sessions.
- revoked devices must stop syncing.

---

# Drive Item Model

Use a single logical hierarchy for files and folders.

Canonical representation:

```ts
type DriveItem = {
  id: string;
  ownerUserId: string;

  parentId: string | null;

  type: "FILE" | "FOLDER";

  name: string;
  normalizedName: string;

  mimeType: string | null;

  sizeBytes: number;

  currentVersionId: string | null;

  revision: number;

  favorite: boolean;

  createdAt: string;
  updatedAt: string;

  deletedAt: string | null;
};
```

Rules:

- root-level items use `parentId = null`.
- folder `sizeBytes` may be `0` in direct API responses unless aggregate size is explicitly requested.
- filenames must not contain path separators.
- `revision` increases on every metadata/content mutation relevant to sync.
- deleted items remain addressable through trash/history APIs until permanently removed.

---

# Duplicate Names

The product should allow duplicate filenames where the underlying OS and logical model permit it only if explicitly supported.

For MVP, use this simpler rule:

> Two non-deleted children under the same parent may not have the same normalized name.

If a collision occurs during user action, return a conflict error.

During sync conflict resolution, clients may create deterministic conflict copies.

Example:

```text
report (Conflict - MacBook Pro - 2026-09-25).docx
```

---

# File Versions

Canonical representation:

```ts
type FileVersion = {
  id: string;
  driveItemId: string;
  storageObjectId: string;

  versionNumber: number;

  sizeBytes: number;
  contentHash: string;
  contentHashAlgorithm: "SHA256";

  sourceDeviceId: string | null;

  createdAt: string;
};
```

Rules:

- immutable once created;
- one DriveItem may reference many FileVersions;
- `currentVersionId` points to the active version;
- restoring an older version should create a new current version rather than mutating historical rows.

---

# Storage Object

Canonical representation:

```ts
type StorageObject = {
  id: string;

  provider: string;
  bucket: string;
  objectKey: string;

  sizeBytes: number;

  contentHash: string;
  contentHashAlgorithm: "SHA256";

  etag: string | null;

  referenceCount: number;

  createdAt: string;
  deletedAt: string | null;
};
```

Rules:

- immutable content;
- never expose `bucket` or raw `objectKey` to normal clients;
- clients should interact through signed URLs or backend-authorized download endpoints;
- deletion must account for references from:
  - current file versions;
  - historical versions;
  - pending transfers;
  - accepted transfers not yet materialized;
  - retention requirements.

---

# Quota Model

Default free quota:

```text
100 GB
```

Use binary or decimal display consistently in the UI, but use bytes internally.

The server must enforce quota atomically.

Canonical quota fields:

```ts
type StorageUsage = {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  availableBytes: number;
};
```

Formula:

```text
availableBytes =
quotaBytes - usedBytes - reservedBytes
```

Never trust client calculations for quota decisions.

---

# Storage Reservation

Canonical representation:

```ts
type StorageReservation = {
  id: string;
  userId: string;
  uploadSessionId: string;

  bytes: number;

  expiresAt: string;
  createdAt: string;
};
```

Rules:

- created before direct upload starts;
- transactionally validates capacity;
- committed to used storage only after successful upload finalization;
- automatically released when expired, aborted, or failed.

---

# Upload Session

Canonical representation:

```ts
type UploadSession = {
  id: string;
  userId: string;
  deviceId: string | null;

  targetParentId: string | null;
  targetName: string;

  expectedSizeBytes: number;

  contentHash: string | null;

  state:
    | "CREATED"
    | "UPLOADING"
    | "COMPLETING"
    | "COMPLETED"
    | "FAILED"
    | "ABORTED"
    | "EXPIRED";

  multipart: boolean;

  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};
```

---

# Upload API Contract

## Create upload

```http
POST /v1/uploads
```

Request:

```json
{
  "parentId": null,
  "name": "video.mov",
  "sizeBytes": 12884901888,
  "mimeType": "video/quicktime",
  "deviceId": "device-id",
  "contentHash": null
}
```

Response:

```json
{
  "upload": {
    "id": "upload-id",
    "state": "CREATED",
    "multipart": true,
    "partSizeBytes": 67108864,
    "expiresAt": "2026-09-25T12:00:00.000Z"
  },
  "storage": {
    "quotaBytes": 107374182400,
    "usedBytes": 21474836480,
    "reservedBytes": 12884901888,
    "availableBytes": 73014444032
  }
}
```

If insufficient storage:

```http
409 Conflict
```

Error code:

```text
STORAGE_QUOTA_EXCEEDED
```

---

# Multipart Upload Parts

Preferred approach:

1. backend allocates upload session;
2. backend creates provider multipart session;
3. client requests signed URLs in batches;
4. client uploads directly;
5. client reports successful part ETags;
6. backend completes multipart upload;
7. backend verifies/commits metadata.

Suggested endpoint:

```http
POST /v1/uploads/{uploadId}/parts
```

Request:

```json
{
  "partNumbers": [1, 2, 3, 4]
}
```

Response:

```json
{
  "parts": [
    {
      "partNumber": 1,
      "uploadUrl": "short-lived-signed-url",
      "expiresAt": "..."
    }
  ]
}
```

Do not expose permanent storage credentials.

---

# Complete Upload

```http
POST /v1/uploads/{uploadId}/complete
```

Request:

```json
{
  "parts": [
    {
      "partNumber": 1,
      "etag": "..."
    }
  ],
  "contentHash": "sha256..."
}
```

Response:

```json
{
  "item": {
    "id": "drive-item-id",
    "type": "FILE",
    "name": "video.mov",
    "sizeBytes": 12884901888,
    "revision": 1
  }
}
```

Completion must be idempotent.

Repeated identical completion requests must return the same logical result.

---

# Download Contract

Preferred flow:

```http
POST /v1/downloads
```

Request:

```json
{
  "driveItemId": "file-id",
  "versionId": null
}
```

Response:

```json
{
  "downloadUrl": "short-lived-signed-url",
  "expiresAt": "...",
  "sizeBytes": 12884901888,
  "contentHash": "sha256...",
  "contentHashAlgorithm": "SHA256"
}
```

Authorization must happen before a signed URL is issued.

Supported authorization sources:

- ownership;
- accepted transfer;
- explicit authenticated share.

No public download URLs.

---

# Folder API

Suggested endpoints:

```http
GET    /v1/drive/items/{id}
GET    /v1/drive/folders/{id}/children
POST   /v1/drive/folders
PATCH  /v1/drive/items/{id}
POST   /v1/drive/items/{id}/move
DELETE /v1/drive/items/{id}
POST   /v1/drive/items/{id}/restore
DELETE /v1/drive/items/{id}/permanent
```

For root:

```text
folder id = root
```

may be represented either as:

```text
null
```

or a virtual identifier.

Choose one convention and keep it consistent.

Recommended:

```text
parentId = null
```

for root-level items.

---

# Folder Listing

```http
GET /v1/drive/folders/{folderId}/children?cursor=...&limit=100
```

Response:

```json
{
  "items": [],
  "nextCursor": null
}
```

Use cursor pagination.

Do not use offset pagination for large folders.

---

# Item Mutation

Renaming:

```http
PATCH /v1/drive/items/{id}
```

Request:

```json
{
  "name": "new-name.pdf",
  "baseRevision": 8,
  "operationId": "client-generated-id"
}
```

Successful response increments revision.

If base revision is stale:

```http
409 Conflict
```

Error code:

```text
REVISION_CONFLICT
```

Include current server state.

---

# Operation Idempotency

Mutating sync-aware endpoints should accept:

```text
operationId
```

generated by clients.

Server must persist recently completed operation IDs per user/device.

If the same operation is retried:

- do not perform it twice;
- return the original result where possible.

Recommended retention:

```text
at least 7 days
```

---

# Trash Semantics

Deleting moves items to trash.

```text
deletedAt != null
```

Children of a deleted folder are logically inaccessible through normal drive browsing.

Restore should preserve original location where possible.

If parent no longer exists, restore to root or a deterministic recovery folder.

Permanent deletion must be explicit.

---

# Favorites

Favorite is a user-specific metadata flag.

Endpoint:

```http
PUT /v1/drive/items/{id}/favorite
DELETE /v1/drive/items/{id}/favorite
```

---

# Search

MVP search is metadata-only.

Endpoint:

```http
GET /v1/search?q=invoice&type=file&cursor=...
```

Supported filters:

```text
q
type
mimeType
extension
parentId
createdAfter
createdBefore
updatedAfter
updatedBefore
favorite
```

Do not inspect file contents.

---

# Transfer Model

Transfers represent delivery of copies between authenticated identities.

Canonical transfer representation:

```ts
type Transfer = {
  id: string;

  senderUserId: string;

  recipientUserId: string | null;
  recipientEmail: string | null;

  state:
    | "PENDING_RECIPIENT_SIGNUP"
    | "PENDING"
    | "ACCEPTED"
    | "DECLINED"
    | "CANCELLED"
    | "EXPIRED";

  createdAt: string;

  acceptedAt: string | null;
  declinedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string | null;
};
```

---

# Transfer Item

```ts
type TransferItem = {
  id: string;
  transferId: string;

  sourceDriveItemId: string;
  sourceVersionId: string;

  displayName: string;

  itemType: "FILE" | "FOLDER";

  sizeBytes: number;
};
```

A folder transfer may internally use a manifest.

---

# Create Transfer

```http
POST /v1/transfers
```

Existing user by username:

```json
{
  "recipient": {
    "type": "USERNAME",
    "value": "rahul"
  },
  "items": [
    {
      "driveItemId": "file-id"
    }
  ]
}
```

Existing or unknown user by email:

```json
{
  "recipient": {
    "type": "EMAIL",
    "value": "rahul@example.com"
  },
  "items": [
    {
      "driveItemId": "file-id"
    }
  ]
}
```

Server behavior:

### Username exists

```text
state = PENDING
recipientUserId = resolved user
```

### Email belongs to existing account

```text
state = PENDING
recipientUserId = resolved user
```

### Email does not belong to account

```text
state = PENDING_RECIPIENT_SIGNUP
recipientUserId = null
recipientEmail = normalized email
```

Send invitation email.

---

# Transfer Privacy

A recipient cannot inspect transfer contents until:

- they are authenticated;
- they are the intended recipient;
- transfer state permits access.

For unregistered email recipient:

- signup email must match pending-transfer recipient email;
- email verification must succeed;
- backend then binds transfer to the new account.

Do not allow someone to claim a transfer merely because they know its ID.

---

# Claim Pending Transfers

Upon verified account creation:

```text
normalized verified email
    ->
find PENDING_RECIPIENT_SIGNUP transfers
    ->
bind recipientUserId
    ->
state = PENDING
```

This must be transactional.

---

# Accept Transfer

```http
POST /v1/transfers/{id}/accept
```

Response:

```json
{
  "transfer": {
    "id": "...",
    "state": "ACCEPTED"
  }
}
```

Acceptance grants the recipient the right to:

- download transfer content;
- save it to their drive.

Acceptance alone does not necessarily consume recipient storage quota.

Saving to Drive does.

---

# Decline Transfer

```http
POST /v1/transfers/{id}/decline
```

After decline:

- recipient loses transfer access;
- sender sees declined state;
- operation is irreversible unless a new transfer is created.

---

# Cancel Transfer

```http
POST /v1/transfers/{id}/cancel
```

Sender may cancel only while:

```text
PENDING
PENDING_RECIPIENT_SIGNUP
```

---

# Save Transfer to Drive

```http
POST /v1/transfers/{id}/save
```

Request:

```json
{
  "targetParentId": null
}
```

Rules:

- transfer must be accepted;
- recipient must have enough available storage;
- storage accounting must happen atomically;
- backend may use provider-side copy;
- do not require client re-upload.

On insufficient recipient capacity:

```text
STORAGE_QUOTA_EXCEEDED
```

---

# Transfer Folder Manifests

Folder transfers should preserve hierarchy.

Example:

```ts
type TransferManifestEntry = {
  relativePath: string;
  itemType: "FILE" | "FOLDER";
  sourceDriveItemId: string;
  sourceVersionId: string | null;
  sizeBytes: number;
};
```

Do not require server-side ZIP generation.

---

# Received API

```http
GET /v1/transfers/received?state=PENDING&cursor=...
```

Response should include:

- sender;
- transfer metadata;
- transfer items;
- total size;
- timestamps.

---

# Sent API

```http
GET /v1/transfers/sent?cursor=...
```

Include:

- recipient account identity where resolved;
- recipient email where unresolved;
- current state;
- timestamps.

---

# Sharing Model

Sharing represents continued access to the same logical item.

Transfer and sharing are separate concepts.

Canonical permission values:

```text
VIEWER
EDITOR
```

Canonical share:

```ts
type ShareGrant = {
  id: string;

  driveItemId: string;

  ownerUserId: string;
  recipientUserId: string;

  permission: "VIEWER" | "EDITOR";

  createdAt: string;
  revokedAt: string | null;
};
```

MVP sharing requires an existing authenticated account.

No anonymous/public link sharing.

---

# Share API

```http
POST /v1/shares
```

Request:

```json
{
  "driveItemId": "folder-id",
  "recipient": {
    "type": "USERNAME",
    "value": "rahul"
  },
  "permission": "VIEWER"
}
```

Revocation:

```http
DELETE /v1/shares/{shareId}
```

Shared-with-me:

```http
GET /v1/shares/received
```

---

# Shared Folder Mutation

For MVP:

- VIEWER cannot mutate content.
- EDITOR may create/update/delete items inside shared folders if implemented.
- ownership remains with original owner.

Every shared-folder mutation must apply to the owner's storage quota.

Do not charge shared recipients separately for access to owner's files.

---

# Sync Model

The sync protocol must be durable and cursor-based.

Clients must be able to recover after:

- hours offline;
- process restart;
- network failure;
- missed real-time events.

Real-time notifications are only wake-up hints.

The durable change feed is authoritative.

---

# Sync Change Record

Canonical representation:

```ts
type SyncChange = {
  sequence: number;

  type:
    | "FILE_CREATED"
    | "FILE_UPDATED"
    | "FILE_DELETED"
    | "FILE_RESTORED"
    | "FOLDER_CREATED"
    | "ITEM_MOVED"
    | "ITEM_RENAMED"
    | "FAVORITE_CHANGED"
    | "SHARE_CHANGED"
    | "TRANSFER_CREATED"
    | "TRANSFER_ACCEPTED"
    | "TRANSFER_DECLINED";

  entityId: string;

  revision: number | null;

  occurredAt: string;
};
```

`sequence` must be monotonically increasing within the user's sync stream.

---

# Change Feed

```http
GET /v1/sync/changes?cursor=12345&limit=500
```

Response:

```json
{
  "changes": [],
  "nextCursor": 12345,
  "hasMore": false
}
```

If the cursor is too old and compacted:

```http
410 Gone
```

Error:

```text
SYNC_CURSOR_EXPIRED
```

Client must then perform a full metadata reconciliation.

---

# Sync Operation

```http
POST /v1/sync/operations
```

Request:

```json
{
  "deviceId": "device-id",
  "operations": [
    {
      "operationId": "uuid",
      "type": "RENAME_ITEM",
      "entityId": "item-id",
      "baseRevision": 8,
      "payload": {
        "name": "report-final.docx"
      }
    }
  ]
}
```

Response:

```json
{
  "results": [
    {
      "operationId": "uuid",
      "status": "APPLIED",
      "revision": 9
    }
  ]
}
```

Possible statuses:

```text
APPLIED
ALREADY_APPLIED
CONFLICT
REJECTED
```

---

# Conflict Semantics

If client mutation uses stale `baseRevision`:

```text
CONFLICT
```

Server should return:

```json
{
  "operationId": "...",
  "status": "CONFLICT",
  "serverItem": {},
  "serverRevision": 10
}
```

For content conflicts, clients must preserve user data.

Recommended desktop behavior:

1. retain server current version;
2. upload divergent local content as conflict copy;
3. create deterministic filename;
4. surface conflict to user.

---

# Sync Checkpoint

Desktop client should persist server cursor locally.

Optionally report:

```http
POST /v1/sync/checkpoints
```

Request:

```json
{
  "deviceId": "device-id",
  "cursor": 128812
}
```

Backend may use checkpoints for observability and stale-device cleanup.

---

# Real-Time Events

Use WebSocket or SSE.

Canonical event envelope:

```ts
type RealtimeEvent = {
  id: string;
  type: string;
  occurredAt: string;
  payload: unknown;
};
```

Suggested events:

```text
drive.changed
transfer.created
transfer.accepted
transfer.declined
share.changed
quota.changed
device.revoked
```

Clients receiving `drive.changed` should fetch the durable sync feed.

---

# Notification Model

Canonical notification:

```ts
type Notification = {
  id: string;

  type:
    | "TRANSFER_RECEIVED"
    | "TRANSFER_ACCEPTED"
    | "TRANSFER_DECLINED"
    | "SHARE_RECEIVED"
    | "STORAGE_NEAR_LIMIT"
    | "STORAGE_FULL"
    | "NEW_DEVICE_SIGN_IN";

  readAt: string | null;

  createdAt: string;

  data: Record<string, unknown>;
};
```

Do not put sensitive file contents into notification payloads.

---

# Backup Model

Desktop backup differs from sync.

Sync:

```text
cloud changes <-> local sync folder
```

Backup:

```text
existing local folder -> cloud backup
```

Remote backup state must not automatically overwrite source folders.

Canonical backup root:

```ts
type BackupRoot = {
  id: string;
  userId: string;
  deviceId: string;

  localPathDisplayName: string;

  remoteRootDriveItemId: string;

  state:
    | "ACTIVE"
    | "PAUSED"
    | "ERROR"
    | "REMOVED";

  createdAt: string;
  updatedAt: string;
};
```

Do not send raw absolute local paths to other clients unnecessarily.

---

# Billing Model

Billing only modifies storage entitlement.

Canonical plan:

```ts
type StoragePlan = {
  id: string;
  name: string;
  storageBytes: number;
  priceMinorUnits: number;
  currency: string;
  billingPeriod: "MONTH" | "YEAR";
};
```

Canonical entitlement:

```ts
type StorageEntitlement = {
  userId: string;
  baseFreeBytes: number;
  paidBytes: number;
  totalQuotaBytes: number;
};
```

Product features must not check plan tier.

They should only check:

```text
available storage
```

where storage is required.

---

# Billing Behavior

Upgrade:

```text
100 GB -> 500 GB
```

should simply increase:

```text
storageQuotaBytes
```

Downgrade:

If current usage exceeds new quota:

- do not delete data automatically;
- block new storage-consuming operations;
- allow download/delete;
- clearly communicate over-quota state.

---

# API Error Envelope

All APIs must use the same error shape.

Canonical response:

```json
{
  "error": {
    "code": "STORAGE_QUOTA_EXCEEDED",
    "message": "There is not enough available storage for this operation.",
    "requestId": "req_...",
    "details": {
      "requiredBytes": 12884901888,
      "availableBytes": 6442450944
    }
  }
}
```

`message` is human-readable.

`code` is stable and machine-readable.

`details` is structured and optional.

---

# Canonical Error Codes

At minimum:

```text
AUTH_REQUIRED
AUTH_INVALID
AUTH_EXPIRED
EMAIL_NOT_VERIFIED
FORBIDDEN

USER_NOT_FOUND
USERNAME_TAKEN
EMAIL_ALREADY_REGISTERED

DEVICE_NOT_FOUND
DEVICE_REVOKED

ITEM_NOT_FOUND
PARENT_NOT_FOUND
NAME_CONFLICT
INVALID_NAME
REVISION_CONFLICT

UPLOAD_NOT_FOUND
UPLOAD_EXPIRED
UPLOAD_ALREADY_COMPLETED
UPLOAD_PART_INVALID

DOWNLOAD_NOT_ALLOWED

STORAGE_QUOTA_EXCEEDED
STORAGE_RESERVATION_EXPIRED

TRANSFER_NOT_FOUND
TRANSFER_NOT_ALLOWED
TRANSFER_ALREADY_ACCEPTED
TRANSFER_ALREADY_DECLINED
TRANSFER_ALREADY_CANCELLED
TRANSFER_EXPIRED
TRANSFER_RECIPIENT_MISMATCH

SHARE_NOT_FOUND
SHARE_NOT_ALLOWED

SYNC_CURSOR_EXPIRED
SYNC_OPERATION_INVALID

RATE_LIMITED
VALIDATION_ERROR
INTERNAL_ERROR
```

Clients should branch on `code`, never parse error strings.

---

# HTTP Status Mapping

Recommended:

```text
400 VALIDATION_ERROR
401 AUTH_REQUIRED / AUTH_INVALID / AUTH_EXPIRED
403 FORBIDDEN / EMAIL_NOT_VERIFIED
404 *_NOT_FOUND
409 NAME_CONFLICT / REVISION_CONFLICT / STORAGE_QUOTA_EXCEEDED
410 SYNC_CURSOR_EXPIRED / TRANSFER_EXPIRED
422 invalid domain state transition
429 RATE_LIMITED
500 INTERNAL_ERROR
```

---

# Pagination

Use cursor pagination consistently.

Canonical response:

```json
{
  "items": [],
  "nextCursor": "opaque-cursor-or-null"
}
```

Never expose raw database offset cursors if avoidable.

---

# Sorting

Folder listing should support:

```text
name
updatedAt
createdAt
sizeBytes
```

Direction:

```text
asc
desc
```

Server owns canonical sorting semantics.

---

# Idempotency

For network-retry-sensitive mutations support:

```text
Idempotency-Key
```

or an explicit `operationId`.

Required for:

- upload creation;
- upload completion;
- transfer creation;
- sync operations;
- billing webhook processing;
- save-transfer-to-drive where duplicate execution would consume storage twice.

---

# Request IDs

Every response must include:

```text
X-Request-ID
```

Clients should log it for diagnostics.

If client sends:

```text
X-Request-ID
```

backend may preserve it when safe, or issue its own trace ID and return both.

---

# Versioning

All APIs must be namespaced:

```text
/v1/...
```

Do not make breaking changes inside an existing version.

OpenAPI should be generated from implementation and treated as a machine-readable projection of this contract.

---

# Client Generation

The backend should publish:

```text
openapi.json
```

Generate a typed TypeScript client package.

Recommended package:

```text
@product/api-client
```

Both web and Electron should consume this package where possible.

Do not hand-maintain duplicate request/response TypeScript types in each client.

---

# Shared Type Package

Create a package such as:

```text
@product/contracts
```

Containing stable non-runtime-sensitive types and enums:

```text
Platform
DriveItemType
TransferState
UploadState
NotificationType
SyncChangeType
SyncOperationStatus
SharePermission
ErrorCode
```

Avoid leaking ORM-generated types directly into clients.

---

# Monorepo Recommendation

If all applications live in one repository, recommended structure:

```text
apps/
  backend/
  web/
  desktop/

packages/
  api-client/
  contracts/
  config/
  eslint-config/
  tsconfig/
```

If repositories are separate:

- publish internal packages;
- or generate versioned artifacts in CI.

---

# Event Compatibility

When adding fields:

- prefer additive changes;
- clients must ignore unknown fields;
- backend should tolerate old clients where practical.

When adding enum values:

- clients should render unknown values safely;
- do not crash on future server states.

---

# Security Contract

Every backend request must perform object-level authorization.

Possession of:

```text
driveItemId
transferId
shareId
storageObjectId
```

must never imply authorization.

Signed URLs:

- must be short-lived;
- must be scoped to one object/action;
- must be generated only after authorization;
- must not be reusable indefinitely.

---

# File Hashing

Use SHA-256 as the canonical content hash initially.

Desktop:

- hash streaming;
- avoid loading entire file into memory.

Web:

- hash in Worker where practical;
- backend must not require pre-upload hashing if it creates unacceptable UX for huge browser uploads.

Backend may verify asynchronously after upload where needed.

---

# Content Type

Client-provided MIME types are hints.

Do not trust MIME type for security-sensitive behavior.

Server or downstream systems may validate content independently where required.

---

# Filenames

Canonical constraints:

- preserve Unicode filenames;
- normalize consistently;
- prohibit `/`;
- prohibit null bytes;
- sanitize Content-Disposition;
- handle Windows-reserved names in desktop client;
- prevent path traversal.

Desktop must adapt logical names to filesystem restrictions without corrupting cloud metadata.

Document mappings where required.

---

# Large File Design

Architectural target:

```text
>= 100 GB individual file
```

No backend API process may buffer entire files.

All file movement should use streaming/direct object-storage transfer.

---

# Transfer Economics Constraint

The product exposes unlimited normal person-to-person transfers.

Therefore:

- no public anonymous links;
- authenticated sender required;
- authenticated recipient required before content access;
- record sender, recipient, bytes, timestamps;
- abuse controls may detect automated distribution patterns;
- normal users must not see arbitrary transfer quotas.

This is a product invariant.

---

# Audit Events

Canonical audit events:

```text
LOGIN
LOGIN_FAILED
LOGOUT

DEVICE_REGISTERED
DEVICE_REVOKED

UPLOAD_CREATED
UPLOAD_COMPLETED
UPLOAD_ABORTED

FILE_DOWNLOADED
FILE_RENAMED
FILE_MOVED
FILE_DELETED
FILE_RESTORED

TRANSFER_CREATED
TRANSFER_ACCEPTED
TRANSFER_DECLINED
TRANSFER_CANCELLED

SHARE_GRANTED
SHARE_REVOKED

PASSWORD_CHANGED
EMAIL_VERIFIED

BILLING_PLAN_CHANGED
```

Do not store file contents in audit logs.

---

# Database Consistency Rules

Use transactions for operations that mutate multiple related resources.

Critical transactional operations:

## Upload finalization

```text
verify upload
create StorageObject
create FileVersion
create/update DriveItem
release reservation
increment used storage
append sync change
```

## Save transfer to drive

```text
verify accepted transfer
verify quota
reserve/consume recipient storage
create recipient DriveItem
create recipient FileVersion
create/copy StorageObject reference
append sync change
```

## Claim pending transfers

```text
verify email
resolve pending transfers
bind recipientUserId
change states
create notifications
```

## Device revocation

```text
revoke device
revoke associated sessions
emit security event
```

---

# Reference Counting

If physical object reuse is implemented:

- reference counting must be transactional;
- never delete object while referenced;
- background reconciliation job should detect mismatches.

Do not implement cross-user content-addressed deduplication unless encryption and privacy implications have been explicitly designed.

Initial implementation may use per-user physical object copies.

---

# Object Key Strategy

Object keys should be opaque.

Example:

```text
objects/7b/0192f...
```

Do not encode:

- usernames;
- emails;
- original filenames;
- folder paths.

This reduces metadata leakage and simplifies renames/moves.

---

# Encryption

For MVP:

- TLS in transit;
- provider/server-side encryption at rest.

Design storage abstraction so stronger client-side encryption can be added later.

Do not claim zero-knowledge encryption unless the cryptographic architecture truly provides it.

---

# Rate Limiting

Rate limits are security controls, not product quotas.

Examples:

```text
login attempts
password reset attempts
recipient search
transfer creation automation
API request bursts
```

Return:

```text
429 RATE_LIMITED
```

Do not describe these as consumer transfer limits.

---

# Recipient Search

Endpoint:

```http
GET /v1/users/lookup?q=rahul
```

Return limited identity data:

```json
{
  "users": [
    {
      "id": "...",
      "username": "rahul",
      "displayName": "Rahul Sharma",
      "avatarUrl": null
    }
  ]
}
```

Do not expose email addresses through username search.

Protect against mass enumeration.

---

# Email Invitations

Invitation emails must:

- identify sender safely;
- identify that an authenticated account is required;
- link to signup/login flow;
- avoid embedding permanent file URLs;
- expire appropriately.

After verification, user sees pending transfers in-app.

---

# Notification Delivery

Backend records notification first.

Delivery channels:

```text
in-app
email
desktop real-time
future mobile push
```

Channel failure must not lose the canonical notification record.

---

# Desktop Session Rules

Desktop refresh credentials must be stored in OS credential storage.

Renderer must never receive long-lived secret tokens directly unless architecture requires it.

Prefer main-process networking for sensitive auth operations, or carefully scoped token proxying.

---

# Web Session Rules

Prefer secure `HttpOnly`, `Secure`, `SameSite` cookies for refresh sessions when architecture permits.

Do not store refresh tokens in localStorage.

---

# Future Mobile Compatibility

Do not introduce desktop-only assumptions into backend APIs.

Future iOS/Android clients should be able to:

- browse drive;
- upload;
- download;
- receive transfers;
- send transfers;
- access sync changes;
- register devices;
- receive notifications.

Local filesystem behavior may differ, but domain contracts remain stable.

---

# Seed Data

Development environment should create:

```text
Alice
alice@example.test
@alice

Bob
bob@example.test
@bob
```

Seed:

- a few folders;
- a few files;
- one pending transfer;
- one accepted transfer;
- one shared folder;
- realistic storage usage.

Never use production-like secrets in seed data.

---

# Contract Test Suite

Create a shared contract-test suite.

At minimum validate:

## Authentication

- unauthenticated protected request returns `AUTH_REQUIRED`;
- expired access token behavior is consistent.

## Quota

- upload reservation consumes available capacity;
- concurrent reservations cannot exceed quota;
- failed upload releases reservation.

## Files

- create folder;
- upload file;
- rename with correct revision;
- stale revision returns `REVISION_CONFLICT`;
- trash and restore.

## Transfers

- existing user transfer;
- unregistered-email transfer;
- verified signup claims pending transfer;
- wrong account cannot claim transfer;
- accept;
- decline;
- cancel;
- save to drive;
- recipient quota enforced.

## Sharing

- viewer authorization;
- editor authorization;
- revoked user loses access.

## Sync

- sequence is monotonic;
- cursor pagination;
- idempotent operation replay;
- stale revision conflict;
- cursor-expired recovery behavior.

## Security

- raw object IDs cannot bypass authorization;
- signed download URL requires authorization;
- revoked device cannot continue sync.

---

# OpenAPI Requirements

Document:

- every endpoint;
- every request schema;
- every response schema;
- every error response;
- auth requirements;
- enum values;
- pagination semantics.

Generate examples for critical flows.

OpenAPI generation must be part of CI.

---

# CI Requirements

CI must fail on:

- TypeScript errors;
- lint errors;
- contract-test failures;
- OpenAPI generation errors;
- schema migration inconsistency;
- client generation drift.

If generated API client differs from committed/generated artifact, CI should identify it.

---

# Schema Migration Rules

All production schema changes must use migrations.

Never rely on:

```text
db push
```

for production evolution.

Migrations should be forward-safe.

Avoid destructive schema changes without explicit data migration.

---

# Observability Contract

Metrics should use stable names.

Recommended:

```text
users_registered_total
users_active

storage_used_bytes
storage_reserved_bytes

uploads_started_total
uploads_completed_total
uploads_failed_total

downloads_completed_total
download_bytes_total

transfers_created_total
transfers_accepted_total
transfers_declined_total
transfer_bytes_total

sync_operations_total
sync_conflicts_total

quota_exceeded_total
```

Avoid dimensions with unbounded cardinality such as filenames or user IDs.

---

# Required End-to-End Contract Scenario

All implementations should remain compatible with this scenario:

```text
1. Alice signs up.
2. Alice verifies email.
3. Alice registers a desktop device.
4. Alice uploads project.zip.
5. Upload consumes storage quota.
6. File appears in My Drive.
7. Alice sends project.zip to @bob.
8. Bob sees transfer in Received.
9. Bob accepts.
10. Bob downloads the file.
11. Downloaded SHA-256 matches original.
12. Bob saves transfer to My Drive.
13. Bob's storage usage increases.
14. Bob's sync feed contains the new item.
15. Bob's desktop client downloads it.
16. Alice sees transfer state = ACCEPTED.
```

Second required scenario:

```text
1. Alice sends photos.zip to charlie@example.test.
2. Charlie does not have an account.
3. Transfer state = PENDING_RECIPIENT_SIGNUP.
4. Charlie receives invitation.
5. Charlie signs up using charlie@example.test.
6. Charlie verifies email.
7. Backend binds pending transfer to Charlie.
8. Transfer state = PENDING.
9. Charlie sees it in Received.
10. Charlie accepts.
```

Third required scenario:

```text
1. Alice has only 5 GB available.
2. Alice attempts to upload/send a 12 GB local file.
3. Reservation fails with STORAGE_QUOTA_EXCEEDED.
4. No partial logical file is created.
5. Client shows storage upgrade flow.
6. Client does not show a transfer-specific purchase.
```

---

# Implementation Priority

When ambiguity appears, prioritize in this order:

1. data safety;
2. authorization correctness;
3. deterministic sync semantics;
4. resumability;
5. quota correctness;
6. transfer correctness;
7. user-visible polish;
8. storage optimization.

Never sacrifice correctness to implement deduplication or clever storage optimization early.

---

# Definition of Done

This shared contract is implemented correctly when:

- backend models and API responses conform to it;
- web app uses the generated API client or compatible schemas;
- Electron app uses the same types and state semantics;
- transfer states mean the same thing everywhere;
- storage quota calculations are identical everywhere;
- sync conflict behavior is documented and deterministic;
- OpenAPI reflects the contract;
- shared enums/types are generated or centrally maintained;
- contract tests pass;
- no client depends on undocumented backend behavior;
- no backend feature relies on client-specific hacks.

Treat this document as the canonical compatibility specification for the product.

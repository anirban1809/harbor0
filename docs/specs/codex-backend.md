# Codex Prompt — Backend

## Goal

Build the backend for a consumer cloud-storage, backup, sync, and person-to-person file-transfer product.

The product has a deliberately simple commercial model:

- Every account gets **100 GB of storage for free**.
- Users pay only when they want additional storage.
- Backup, sync, multi-device use, and file transfers are included for free.
- Do not introduce transfer quotas, device limits, feature gating, or paid-only functionality into the MVP.
- There is **no anonymous file sharing**.
- Every file transfer has an authenticated sender and an authenticated recipient.
- A sender may address a transfer to an email address belonging to someone who does not yet have an account, but that recipient must create and verify an account before receiving or downloading the file.
- All transfers happen over the internet.
- Nearby-device discovery is out of scope.
- AI analysis of private files is out of scope.
- Mobile applications are out of scope for now.
- The first clients are:
  - a web application;
  - an Electron desktop application for macOS, Windows, and Linux.

Build this as a production-oriented TypeScript backend with clean boundaries, strong tests, and documented APIs.

---

# Technology Stack

Use:

- Node.js
- TypeScript
- NestJS
- PostgreSQL
- Prisma ORM
- Redis
- BullMQ for asynchronous jobs
- OpenAPI / Swagger
- WebSocket or Server-Sent Events for real-time transfer and sync notifications
- S3-compatible object-storage abstraction
- Docker Compose for local development
- Vitest or Jest for tests
- ESLint
- Prettier

For object storage:

- Implement a provider abstraction.
- The first provider implementation should target an S3-compatible service.
- Keep configuration provider-neutral so Cloudflare R2 or AWS S3 can be used without changing domain logic.
- Support multipart upload, resumable uploads, ranged downloads, object deletion, server-side copy where supported, and presigned URLs.
- Do not hard-code provider-specific URLs into business logic.

Use environment variables for all infrastructure configuration.

---

# Core Product Model

The backend should support four product pillars.

## 1. Store

Users have a private cloud drive.

Free account quota:

```text
100 GB
```

Users can:

- create folders;
- upload files;
- download files;
- rename files and folders;
- move files and folders;
- delete files and folders;
- restore deleted files;
- browse files;
- search metadata;
- retrieve file metadata;
- access recent files;
- mark favorites;
- maintain basic file-version history.

Storage quota is the only consumer-facing usage limit.

---

## 2. Backup

The Electron client can register backup roots such as:

```text
Desktop
Documents
Pictures
Projects
```

The backend must track:

- device;
- backup root;
- relative path;
- current file version;
- object reference;
- upload state;
- timestamps;
- deletion state.

Backups should not require a separate paid feature.

---

## 3. Sync

The Electron client maintains a synchronized drive folder.

The backend must support:

- incremental change feeds;
- file revisions;
- client-generated operation IDs for idempotency;
- conflict detection;
- rename/move events;
- deletion tombstones;
- resumable uploads;
- resumable downloads;
- device checkpoints;
- efficient polling or push-assisted change notification.

Design the protocol so a mobile client can be added later without changing the core sync semantics.

---

## 4. Send

A user can send a file or folder to another person.

Primary UX:

```text
Alice -> @bob
```

The sender addresses a person, not a particular device.

Transfers are account-to-account.

The recipient can:

- accept;
- decline;
- save the file into their drive;
- download it;
- choose where the desktop client stores it.

The recipient may be offline when the transfer is created.

The transfer remains available until accepted, declined, cancelled, or expired according to configurable retention policy.

There are no public unauthenticated transfer URLs.

---

# Identity

Every user must have:

```text
id
email
emailVerified
username
displayName
avatarUrl
storageQuotaBytes
storageUsedBytes
createdAt
updatedAt
```

`username` must be unique and suitable for direct addressing:

```text
@anirban
```

Implement:

- email/password authentication;
- email verification;
- password reset;
- refresh-token rotation;
- session/device management;
- optional passkey-ready architecture, even if passkeys are not implemented in the first iteration;
- rate limiting;
- brute-force protection.

Use short-lived access tokens and secure refresh-token handling.

Do not store plaintext passwords or refresh tokens.

---

# Devices

A user can have unlimited registered devices.

Model:

```text
Device
- id
- userId
- name
- platform
- appVersion
- devicePublicId
- lastSeenAt
- createdAt
- revokedAt
```

Supported platform values:

```text
WEB
MACOS
WINDOWS
LINUX
IOS
ANDROID
```

Only WEB, MACOS, WINDOWS, and LINUX need working clients now.

The API should already tolerate future mobile clients.

Users must be able to revoke devices.

---

# File Model

Design a clean metadata model.

Suggested concepts:

```text
DriveItem
StorageObject
FileVersion
Folder
TrashEntry
Favorite
```

A practical schema may use a unified hierarchical `DriveItem` table with:

```text
id
ownerUserId
parentId
type                 FILE | FOLDER
name
normalizedName
mimeType
sizeBytes
currentVersionId
createdAt
updatedAt
deletedAt
```

File contents should be represented separately from logical filesystem entries.

Suggested storage-object fields:

```text
id
provider
bucket
objectKey
sizeBytes
contentHash
etag
createdAt
deletedAt
```

Do not rely on object-storage folder semantics for the user's filesystem.

The database owns hierarchy and metadata.

---

# File Versions

For each file update, create a version record.

Suggested model:

```text
FileVersion
- id
- driveItemId
- storageObjectId
- sizeBytes
- contentHash
- sourceDeviceId
- createdAt
```

Keep retention policy configurable.

For MVP, use a simple default history period rather than implementing complex tier-specific policies.

---

# Storage Quota

Free quota:

```text
100 GB
```

Use bytes internally.

Before committing an upload, reserve capacity transactionally.

Prevent race conditions where concurrent uploads exceed quota.

Suggested model:

```text
StorageReservation
- id
- userId
- bytes
- expiresAt
- uploadSessionId
```

Quota flow:

```text
request upload
    ->
validate available capacity
    ->
create reservation
    ->
perform upload
    ->
commit object
    ->
convert reservation into used storage
```

Abandoned reservations must expire automatically.

The application must never silently exceed the user's purchased capacity.

---

# Upload Architecture

Implement multipart/resumable upload.

Suggested flow:

```text
POST /uploads
POST /uploads/:id/parts
POST /uploads/:id/complete
DELETE /uploads/:id
```

The backend may return signed upload URLs so file bytes travel directly between the client and object storage.

Track:

```text
UploadSession
- id
- userId
- deviceId
- targetParentId
- targetName
- expectedSize
- contentHash
- providerUploadId
- state
- expiresAt
```

States:

```text
CREATED
UPLOADING
COMPLETING
COMPLETED
FAILED
ABORTED
EXPIRED
```

All endpoints must be idempotent where practical.

---

# Downloads

Support:

- authenticated download authorization;
- byte-range requests;
- resumable downloads;
- short-lived signed URLs;
- audit records.

A user may download:

- files they own;
- accepted transfers;
- files explicitly shared with their account.

Never generate a publicly accessible permanent object URL.

---

# Transfers

Suggested model:

```text
Transfer
- id
- senderUserId
- recipientUserId nullable
- recipientEmail nullable
- state
- createdAt
- acceptedAt
- declinedAt
- cancelledAt
- expiresAt
```

And:

```text
TransferItem
- id
- transferId
- sourceDriveItemId
- sourceVersionId
- displayName
- sizeBytes
```

Transfer states:

```text
PENDING_RECIPIENT_SIGNUP
PENDING
ACCEPTED
DECLINED
CANCELLED
EXPIRED
```

Rules:

1. Existing account by username/email:
   - create transfer;
   - notify recipient immediately.

2. Email without an account:
   - create pending transfer;
   - send invitation email;
   - recipient creates and verifies account;
   - atomically bind pending transfers to that account;
   - expose them in `Received`.

3. Recipient accepts:
   - recipient may download directly;
   - recipient may save a logical copy into their drive.

4. Recipient declines:
   - transfer becomes inaccessible to them.

5. Sender may cancel while pending.

---

# Saving Transfers to Drive

When the recipient chooses `Save to Drive`, optimize the operation.

If storage architecture and provider permit safe internal reuse:

- avoid client-side re-upload;
- create a new logical drive reference;
- maintain correct accounting.

Be careful with:

- deletion lifecycle;
- reference counting;
- encryption boundaries;
- quota accounting.

Do not implement unsafe cross-user deduplication purely to save space.

A simple first implementation may perform a provider-side server copy into a recipient-owned object namespace.

Correctness and isolation are more important than deduplication.

---

# Folder Transfers

Users can send folders.

Represent the folder transfer as a manifest of logical entries.

Do not ZIP large folders server-side as the primary transfer mechanism.

Preserve:

- relative paths;
- names;
- MIME types;
- sizes;
- hierarchy.

On acceptance, reconstruct the folder tree in the recipient's drive.

---

# Sharing

Support authenticated collaboration separately from transfers.

Two concepts must remain distinct.

## Send

```text
sender owns file
    ->
recipient receives a copy
```

## Share

```text
owner grants another account access
```

For MVP implement:

- viewer permission;
- editor permission for folders/files where practical;
- remove access;
- list collaborators.

Every collaborator must have an authenticated account.

No public links.

---

# Search

Implement metadata search only for MVP.

Searchable fields:

- filename;
- normalized filename;
- extension;
- MIME type;
- path;
- created date;
- modified date.

Do not inspect private file contents for AI features.

Full-content indexing should remain explicitly out of scope.

---

# Trash and Recovery

Deleting an item should initially create a tombstone/trash state.

Support:

```text
move to trash
restore
permanently delete
empty trash
```

Object deletion should happen asynchronously when retention allows.

Do not immediately destroy content required by version history or accepted transfer semantics.

---

# Sync Protocol

Create an explicit sync API.

Suggested endpoints:

```text
POST /sync/devices/register
GET  /sync/changes?cursor=<cursor>
POST /sync/operations
POST /sync/checkpoint
```

Every change should have a monotonic cursor or ordered sequence.

Suggested change types:

```text
FILE_CREATED
FILE_UPDATED
FILE_DELETED
FILE_RESTORED
ITEM_MOVED
ITEM_RENAMED
FOLDER_CREATED
SHARE_CHANGED
TRANSFER_CREATED
TRANSFER_ACCEPTED
```

Each client operation must include:

```text
operationId
deviceId
baseRevision
```

Use `operationId` for idempotency.

Use `baseRevision` for conflict detection.

For MVP conflict strategy:

- never silently overwrite divergent content;
- preserve both versions when required;
- mark one as a conflict copy with a deterministic name.

Document the algorithm.

---

# Real-Time Notifications

Use WebSocket or SSE for lightweight events such as:

```text
transfer.created
transfer.accepted
transfer.declined
drive.changed
device.revoked
quota.changed
```

The client must still be able to recover by polling the durable change feed.

Real-time events are hints.

The database/change feed remains authoritative.

---

# Notifications

Create a provider abstraction for notifications.

For MVP support:

- transactional email;
- in-app notification records;
- WebSocket/SSE events.

Future mobile push notifications should fit behind the same abstraction.

Suggested notification events:

```text
TRANSFER_RECEIVED
TRANSFER_ACCEPTED
TRANSFER_DECLINED
SHARE_RECEIVED
STORAGE_NEAR_LIMIT
STORAGE_FULL
NEW_DEVICE_SIGN_IN
```

---

# Billing

Build billing boundaries without tying the MVP to one vendor.

Required concepts:

```text
StoragePlan
Subscription
StorageEntitlement
BillingCustomer
```

Default free entitlement:

```text
100 GB
```

Paid plans only increase storage capacity.

Do not gate application functionality based on plan.

Example API:

```text
GET /billing/plans
GET /billing/subscription
POST /billing/checkout
POST /billing/webhook
```

Create a `BillingProvider` interface.

A Stripe adapter may be used for initial implementation, but keep the domain independent.

---

# Abuse Protection

The product advertises unlimited transfers, so do not implement visible transfer quotas.

Implement protection against misuse through internal safeguards:

- per-account API rate limiting;
- suspicious transfer fan-out detection;
- high-volume automation detection;
- unusual recipient-account creation patterns;
- brute-force prevention;
- request throttling;
- device and session revocation;
- audit events;
- administrator-review hooks.

Do not create arbitrary consumer transfer caps.

The system should distinguish normal person-to-person usage from automated distribution infrastructure.

---

# Audit Logging

Track security-sensitive events:

```text
LOGIN
LOGIN_FAILED
DEVICE_REGISTERED
DEVICE_REVOKED
UPLOAD_CREATED
UPLOAD_COMPLETED
FILE_DOWNLOADED
TRANSFER_CREATED
TRANSFER_ACCEPTED
TRANSFER_DECLINED
SHARE_GRANTED
SHARE_REVOKED
FILE_DELETED
FILE_RESTORED
PASSWORD_CHANGED
```

Avoid storing sensitive file contents in logs.

---

# Security Requirements

Implement:

- HTTPS assumptions in production;
- secure cookies where applicable;
- CSRF protection where applicable;
- CORS configuration;
- strict DTO validation;
- SQL injection resistance through ORM usage;
- object-level authorization checks;
- signed URL expiry;
- rate limiting;
- refresh-token rotation;
- password hashing using Argon2id or an equivalent modern password hash;
- secrets through environment variables;
- structured security logging;
- request IDs;
- filename/path sanitization;
- protection against path traversal;
- content-disposition-safe download names.

Do not expose object-storage credentials to clients.

---

# API Groups

Organize APIs approximately as:

```text
/auth
/users
/devices
/drive
/uploads
/downloads
/transfers
/shares
/sync
/notifications
/billing
/admin
```

Generate OpenAPI documentation.

The frontend and Electron client should be able to generate typed API clients from this contract.

---

# Suggested Repository Structure

```text
backend/
  src/
    modules/
      auth/
      users/
      devices/
      drive/
      storage/
      uploads/
      downloads/
      transfers/
      shares/
      sync/
      notifications/
      billing/
      audit/
      admin/
    common/
    config/
    database/
    jobs/
    main.ts
  prisma/
    schema.prisma
    migrations/
    seed.ts
  test/
  docker/
  docker-compose.yml
  package.json
  README.md
```

Use domain services rather than placing business logic directly in controllers.

---

# Local Development

`docker compose up` should start:

- PostgreSQL;
- Redis;
- local S3-compatible object store such as MinIO;
- mail testing service such as Mailpit.

Provide seeded test accounts.

Example:

```text
alice@example.test
bob@example.test
```

Provide documented passwords only in development seed data.

---

# Testing

Implement:

## Unit tests

For:

- storage quota;
- transfers;
- invitations;
- permissions;
- sync conflicts;
- billing entitlements;
- upload state machine.

## Integration tests

For:

- signup/login;
- multipart upload;
- drive CRUD;
- send file to existing user;
- send file to email without account;
- recipient signup and claim;
- accept transfer;
- decline transfer;
- save transfer to drive;
- share/revoke;
- sync change feed;
- concurrent quota reservations.

## End-to-end test scenario

Automate this flow:

```text
Alice creates account
Bob creates account
Alice uploads a file
Alice sends file to Bob
Bob receives notification
Bob accepts
Bob saves file to drive
Bob downloads file
hash(downloaded file) == hash(original file)
```

Also test:

```text
Alice sends to charlie@example.test
Charlie has no account
Charlie signs up and verifies email
Pending transfer appears
Charlie accepts
```

---

# Observability

Implement:

- structured JSON logs;
- request IDs;
- health endpoint;
- readiness endpoint;
- metrics hooks;
- job failure visibility;
- storage-provider error logging;
- upload/download metrics;
- transfer lifecycle metrics.

Suggested business metrics:

```text
registered_users
active_users
stored_bytes
average_stored_bytes_per_user
uploads_started
uploads_completed
downloads_completed
transfers_created
transfers_accepted
transfer_bytes
storage_upgrades
```

Do not log filenames or private file metadata unnecessarily in telemetry.

---

# Performance Requirements

Design for large files.

The API server should never buffer entire files in memory.

Use direct-to-object-storage uploads/downloads whenever possible.

Support:

- at least 100 GB individual files architecturally;
- multipart upload;
- parallel parts;
- retries;
- range downloads.

Metadata endpoints should remain responsive regardless of file size.

---

# Implementation Phases

Implement in this order.

## Phase 1

- project scaffold;
- auth;
- users;
- devices;
- PostgreSQL schema;
- local Docker development environment.

## Phase 2

- drive metadata;
- object-storage abstraction;
- multipart upload;
- download authorization;
- quota enforcement.

## Phase 3

- transfers;
- invitations;
- received inbox;
- notifications.

## Phase 4

- shares;
- trash;
- versions;
- favorites;
- metadata search.

## Phase 5

- sync change feed;
- operation idempotency;
- conflict handling;
- real-time hints.

## Phase 6

- billing abstraction;
- paid storage entitlements;
- admin/abuse hooks;
- observability hardening.

---

# Definition of Done

Do not stop at scaffolding.

The backend is considered complete for this milestone when:

- it runs locally through Docker Compose;
- database migrations work from a clean database;
- MinIO-backed local file storage works;
- a user can upload and download large files;
- storage quota is correctly enforced;
- two accounts can send/receive a file;
- pending transfers can be addressed to an unregistered email and claimed after signup;
- recipients must authenticate before accessing transfers;
- public anonymous downloads do not exist;
- sync APIs work with cursors and idempotent operations;
- OpenAPI documentation is generated;
- unit/integration/E2E tests pass;
- README documents setup and architecture;
- linting and type checking pass.

When implementing, continuously run tests, type checking, and linting. Fix failures before proceeding. Prefer a working vertical slice over disconnected scaffolding.

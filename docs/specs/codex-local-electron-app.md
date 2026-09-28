# Codex Prompt — Electron Desktop Application

## Goal

Build the local desktop application for a consumer cloud-storage, backup, sync, and authenticated person-to-person file-transfer service.

The application runs on:

- macOS;
- Windows;
- Linux.

Use Electron.

The product proposition is:

> 100 GB free cloud storage. Backup and sync across your devices. Send files directly to people over the internet. Pay only when you need more storage.

Product rules:

- 100 GB storage is free.
- Backup is free.
- Sync is free.
- Multiple devices are free.
- Person-to-person file transfers are free.
- Paid plans only increase cloud-storage capacity.
- Do not introduce transfer quotas or device limits.
- There is no anonymous sharing.
- Every recipient must authenticate before accessing a transferred/shared file.
- Transfers happen over the internet.
- Nearby discovery is out of scope.
- AI file analysis is out of scope.
- Mobile applications will be implemented later.

The desktop application should feel like a native utility, not a website inside a window.

---

# Technology Stack

Use:

- Electron
- TypeScript
- React
- Vite
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Hook Form
- Zod
- Electron Builder or Electron Forge
- secure Electron IPC
- platform keychain through `keytar` or an equivalent maintained secure credential library
- filesystem watcher such as `chokidar`
- SQLite for local sync metadata
- Prisma or a lightweight SQLite layer appropriate for Electron
- Vitest
- Playwright Electron tests where practical

The renderer must not have unrestricted Node.js access.

Use:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

Expose a small typed preload API.

---

# Desktop Architecture

Separate responsibilities clearly.

```text
Electron Main Process
    |
    |-- authentication/session management
    |-- secure token storage
    |-- filesystem access
    |-- filesystem watchers
    |-- sync engine
    |-- backup engine
    |-- download manager
    |-- upload manager
    |-- OS integration
    |-- tray/menu
    |
Preload
    |
    |-- narrow typed IPC bridge
    |
Renderer
    |
    |-- React + shadcn/ui
    |-- drive UI
    |-- transfers
    |-- settings
    |-- status
```

Heavy filesystem work must not run in the renderer.

Use worker threads or subprocesses where useful for hashing or expensive I/O.

---

# Authentication

Use browser-based authentication where practical.

Suggested flow:

```text
Desktop app
    ->
Open web login in default browser
    ->
User authenticates
    ->
Backend redirects to custom protocol
    ->
yourapp://auth/callback
    ->
Desktop app exchanges one-time code
```

Requirements:

- no plaintext passwords stored by desktop app;
- refresh credentials stored in OS keychain;
- device registered after successful login;
- logout revokes local session;
- revoked device immediately stops syncing once detected.

Implement custom protocol handling for macOS, Windows, and Linux.

---

# Main Window

Suggested layout:

```text
┌─────────────────────────────────────────────────────────────┐
│ Search                                     Sync status      │
├───────────────┬─────────────────────────────────────────────┤
│ My Drive      │                                             │
│ Received      │               Files                         │
│ Sent          │                                             │
│ Backups       │                                             │
│ Recent        │                                             │
│ Favorites     │                                             │
│ Trash         │                                             │
│               │                                             │
│ Devices       │                                             │
│ Settings      │                                             │
├───────────────┴─────────────────────────────────────────────┤
│ 24.8 GB / 100 GB                  All files synced          │
└─────────────────────────────────────────────────────────────┘
```

Use shadcn/ui.

---

# System Tray

The app should keep useful background functions available from the tray.

Tray menu:

```text
All files synced

Open My Drive
Open Received
Pause syncing
Upload file
Send file
Settings
Quit
```

Tray icon state should reflect:

```text
SYNCED
SYNCING
PAUSED
OFFLINE
ERROR
```

Do not require the main window to remain open for background sync.

---

# Local Sync Folder

Create a synchronized folder chosen during setup.

Default examples:

macOS:

```text
~/YourApp
```

Windows:

```text
%USERPROFILE%\YourApp
```

Linux:

```text
~/YourApp
```

Allow the user to change the location only through a controlled migration flow.

The sync engine should treat the backend as a versioned remote filesystem.

---

# Sync Engine

Implement a durable sync engine.

The engine must survive:

- app restarts;
- network interruptions;
- sleep/wake;
- process crashes;
- partially completed uploads;
- partially completed downloads.

Maintain a local SQLite database.

Suggested tables:

```text
sync_items
sync_operations
sync_checkpoint
upload_sessions
download_sessions
conflicts
backup_roots
```

Each local tracked item should include:

```text
localPath
remoteItemId
remoteRevision
localMtime
sizeBytes
contentHash
state
```

---

# Sync States

Suggested states:

```text
SYNCED
LOCAL_CHANGED
REMOTE_CHANGED
UPLOADING
DOWNLOADING
DELETED_LOCAL
DELETED_REMOTE
CONFLICT
ERROR
```

Persist state transitions.

Do not rely exclusively on in-memory queues.

---

# Change Detection

Use filesystem watchers for fast detection.

Also periodically reconcile by scanning metadata because watcher events can be lost.

Handle:

- create;
- modify;
- delete;
- rename;
- move;
- directory changes.

Debounce bursty writes.

Do not upload a file while another process is still actively writing when avoidable.

---

# Remote Change Feed

Consume backend sync cursor API.

Example:

```text
GET /sync/changes?cursor=<lastCursor>
```

Persist the acknowledged cursor.

If WebSocket/SSE reports a change:

- wake the sync engine;
- fetch durable changes from backend;
- do not treat the real-time event itself as authoritative state.

---

# Conflict Handling

Never silently discard user data.

Example conflict:

```text
report.docx
```

changed on Laptop A and Laptop B from the same base revision.

Preserve both.

Example local conflict copy:

```text
report (Conflict - Anirban's MacBook - 2026-09-25).docx
```

Record conflict metadata.

Expose conflicts in the UI.

Implement deterministic naming and test it.

---

# Upload Manager

Support large files through multipart/resumable upload.

Requirements:

- chunked upload;
- configurable concurrency;
- retry with exponential backoff;
- pause/resume;
- persisted session state;
- restart recovery;
- progress events;
- bandwidth-efficient streaming;
- never load an entire large file into memory.

Hash files incrementally.

If backend asks for part checksums, calculate them streaming.

---

# Download Manager

Support:

- HTTP range requests;
- resumable downloads;
- persisted progress;
- partial temporary files;
- atomic rename after successful completion;
- checksum verification;
- retries;
- cancel;
- pause/resume.

Do not expose partially downloaded files at the final target path.

Example:

```text
video.mov.partial
```

then atomically:

```text
video.mov
```

after verification.

---

# Backup

Users can add arbitrary backup roots.

Example:

```text
Backups

Documents
/Users/anirban/Documents
Protected

Pictures
/Users/anirban/Pictures
Protected

+ Add folder
```

Backup differs from sync:

- local folder remains in its existing location;
- cloud mirrors changes;
- remote changes should not arbitrarily modify the local source folder unless explicitly part of a restore workflow.

Implement:

```text
add backup root
pause backup
resume backup
remove backup configuration
restore file
restore folder
```

Prevent nested/duplicate backup-root mistakes.

---

# Restore

Support:

```text
Restore file
Restore folder
Restore entire backup root
```

Allow destination choice:

```text
Original location
Choose another folder
```

Never overwrite existing local data without confirmation or conflict-safe behavior.

---

# Person-to-Person Send

The desktop app should make sending a file extremely easy.

Inside app:

```text
Select file
    ->
Send
    ->
@username or email
    ->
Send
```

Also implement OS integration where practical.

---

# Finder / File Explorer Integration

Aim for:

macOS Finder context action:

```text
Send with YourApp
```

Windows File Explorer context action:

```text
Send with YourApp
```

Linux file-manager integration can be implemented where reasonably portable.

If deep native shell integration is complex, begin with:

```text
drag file onto app
```

and:

```text
tray -> Send file
```

Then add platform-specific context-menu integration behind clean adapters.

---

# Sending a Local File

The file must be uploaded into the sender's cloud storage as part of the send flow.

Flow:

```text
Select local file
    ->
Check quota
    ->
Upload/resume upload
    ->
Create transfer
    ->
Recipient notified
```

If insufficient capacity:

```text
File size: 18.4 GB
Available storage: 6.2 GB

You need more storage to send this file.
```

Then route to storage-upgrade page.

Do not introduce a transfer-size purchase or transfer quota.

---

# Send to Existing User

Recipient picker:

```text
To
[ @rahul ]

Rahul Sharma
@rahul
```

Show recent recipients.

Once submitted:

```text
Sending...
Uploading 4.2 GB / 8.4 GB

Then:
Sent to @rahul
```

---

# Send to Email Without Account

Allow:

```text
rahul@example.com
```

UI:

```text
No account found.

Rahul will be invited to create an account before receiving the file.

[Send invitation]
```

Transfer remains pending until recipient registration/verification.

---

# Received Inbox

Example:

```text
Received

Anirban Deb Singha
@anirban

project-assets.zip
8.4 GB

[Accept] [Decline]
```

After accepting:

```text
[Save to My Drive]
[Download]
```

For `Download`, let user choose local destination.

For `Save to My Drive`, server-side operation should be used when available.

---

# Notifications

Use native desktop notifications.

Examples:

```text
Anirban sent you project.zip
```

```text
Rahul accepted photos.zip
```

```text
Your storage is almost full
```

Clicking notification should deep-link into the relevant view.

---

# Sent

Show transfer status:

```text
To @rahul
project.zip
Accepted

To priya@example.com
photos.zip
Waiting for account creation
```

Allow cancellation while pending.

---

# My Drive

Desktop UI should expose the cloud filesystem independently from the local sync folder.

Support:

- browse;
- upload;
- download;
- rename;
- move;
- delete;
- restore;
- favorite;
- send;
- share;
- versions.

Use the same API semantics as the web app.

---

# Selective Sync

Support choosing folders that remain cloud-only.

Example:

```text
Sync to this computer

[x] Documents
[x] Projects
[ ] Videos
[ ] Archive
```

Cloud-only items should still be visible in the desktop app UI.

Do not fake filesystem placeholder integration in the first milestone unless a platform-specific implementation is robust.

A later phase can add Files On-Demand / placeholder semantics.

---

# Offline Behavior

When offline:

- local sync-folder edits continue being recorded;
- queued uploads remain pending;
- downloads pause;
- drive browsing uses cached metadata where practical;
- sending a new local file may be queued but should clearly say it has not been delivered;
- destructive remote actions should wait until connectivity is restored.

Expose:

```text
Offline
Changes will sync when connection returns.
```

---

# Sleep / Wake

Desktop systems frequently sleep.

Handle wake events by:

- verifying network;
- refreshing auth if needed;
- reconciling sync cursor;
- checking incomplete transfer jobs;
- restarting watchers if necessary.

Test this behavior where possible.

---

# Local Database

Use SQLite.

Do not treat the local database as authoritative cloud state.

It is a durable cache and operation journal.

Add migrations.

Ensure corruption/recovery strategy is documented.

---

# Security

Electron security is critical.

Requirements:

- context isolation enabled;
- Node integration disabled in renderer;
- renderer sandbox enabled;
- narrow typed preload bridge;
- validate every IPC payload;
- never expose arbitrary filesystem APIs to renderer;
- restrict navigation;
- block arbitrary new-window creation;
- use Content Security Policy;
- secure credential storage;
- no secrets in renderer bundle;
- no object-storage root credentials;
- signed upload/download URLs are temporary;
- custom-protocol callbacks validated against state/nonce;
- sanitize filenames and paths;
- prevent path traversal;
- verify downloaded hashes before finalizing files.

---

# Updates

Prepare the app for signed automatic updates.

Create an `UpdateService` abstraction.

Do not require a production signing identity for local development, but document:

- macOS signing/notarization;
- Windows code signing;
- Linux package distribution.

---

# OS Packaging

Produce builds for:

```text
macOS: dmg
Windows: exe/msi
Linux: AppImage or deb
```

Architecture should support:

```text
x64
arm64
```

where Electron packaging permits.

---

# Logging

Use structured local logs.

Log:

- sync transitions;
- upload/download errors;
- network failures;
- backend request IDs;
- device/session events.

Do not log:

- auth tokens;
- file contents;
- sensitive file metadata unnecessarily.

Implement log rotation.

Provide:

```text
Help -> Export diagnostic logs
```

with sensitive values redacted.

---

# UI Screens

Build:

```text
Login
Onboarding
My Drive
Received
Sent
Backups
Recent
Favorites
Trash
Devices
Storage
Settings
Sync status
Conflict resolution
Transfer progress
```

Use shadcn/ui consistently.

---

# Settings

Sections:

```text
General
Sync
Backups
Bandwidth
Notifications
Account
Devices
Storage
Advanced
```

Useful options:

```text
Start at login
Show notifications
Pause sync
Upload concurrency
Download concurrency
Use bandwidth limits
```

User-configurable bandwidth throttling is acceptable.

Do not impose product transfer quotas.

---

# Bandwidth Settings

Optional user-controlled limits:

```text
Uploads
Unlimited
or ___ MB/s

Downloads
Unlimited
or ___ MB/s
```

These are local user preferences.

Default to unlimited.

---

# Performance

The application must remain responsive while transferring large files.

Rules:

- stream all file I/O;
- avoid reading huge files into memory;
- batch database operations;
- debounce watcher events;
- use limited concurrent transfers;
- use workers for hashing;
- use backpressure;
- avoid renderer/Main IPC spam by batching progress updates.

---

# Testing

## Unit tests

Test:

- path normalization;
- sync state transitions;
- conflict naming;
- upload state machine;
- download resume;
- backup-root validation;
- quota handling;
- IPC validation.

## Integration tests

Test:

- login callback;
- device registration;
- upload file;
- restart during upload;
- resume upload;
- download file;
- restart during download;
- resume download;
- filesystem edit -> sync;
- remote edit -> local sync;
- local/remote conflict;
- backup upload;
- receive transfer;
- accept transfer;
- decline transfer.

## End-to-end scenario

Automate as much of this as practical:

```text
launch app
authenticate test account
sync folder configured
create local file
file uploads
second test account sends a file
notification appears
accept transfer
download transfer
hash matches sender's original
```

---

# Suggested Repository Structure

```text
desktop/
  src/
    main/
      auth/
      ipc/
      sync/
      backup/
      transfer/
      storage/
      updates/
      os/
      logging/
    preload/
    renderer/
      app/
      components/
      hooks/
      lib/
      stores/
    shared/
      contracts/
      types/
  migrations/
  test/
  scripts/
  package.json
  electron-builder.yml
  README.md
```

Do not mix renderer UI logic with sync-engine internals.

---

# Implementation Order

## Phase 1

- Electron scaffold;
- security settings;
- React/shadcn renderer;
- browser-based authentication;
- device registration;
- tray.

## Phase 2

- local SQLite;
- local sync folder;
- filesystem watcher;
- remote change feed;
- basic upload/download.

## Phase 3

- resumable transfers;
- restart recovery;
- conflicts;
- selective sync.

## Phase 4

- backup roots;
- restore;
- Received/Sent;
- native notifications.

## Phase 5

- Finder/File Explorer integration;
- diagnostics;
- auto-update preparation;
- packaging.

---

# Definition of Done

Do not stop at a UI prototype.

The desktop milestone is complete when:

- app installs/runs on at least macOS and Windows development environments, with Linux-compatible architecture retained;
- authentication works securely;
- device is registered;
- local sync folder works;
- local edits upload;
- remote edits download;
- deletions and renames sync;
- conflicts preserve both versions;
- large uploads/downloads resume after interruption;
- app restart does not lose transfer state;
- backup folders work;
- restore works;
- user can send a local file to another authenticated user;
- recipient receives and accepts a transfer;
- unregistered-email transfer flow is represented correctly;
- anonymous downloads do not exist;
- native notifications work;
- tray behavior works;
- renderer has no unrestricted Node access;
- tests pass;
- linting and type checking pass;
- README documents architecture, setup, packaging, and security assumptions.

Continuously run tests, linting, type checking, and the app during implementation. Fix failures before moving forward. Prefer durable working behavior over mocked functionality.

# Codex Prompt — Web Application

## Goal

Build the web application for a consumer cloud-storage, backup, sync, and authenticated person-to-person file-transfer service.

The product proposition is:

> 100 GB free cloud storage. Backup and sync across devices. Send files directly to people over the internet. Pay only when you need more storage.

Important product rules:

- Every user gets 100 GB free.
- All normal product features are available on the free account.
- Paid plans increase storage capacity only.
- Do not show transfer quotas.
- Do not gate backup, sync, sharing, devices, or transfer functionality behind paid plans.
- There is no anonymous sharing.
- A recipient must authenticate before accessing a sent/shared file.
- A sender can address a file to an email address that has no account yet, but that person must create and verify an account before receiving it.
- All transfers happen over the internet.
- Nearby discovery is out of scope.
- AI analysis of private files is out of scope.
- Mobile apps will be implemented later.

Build a polished production-oriented web client.

---

# Technology Stack

Use:

- Next.js
- TypeScript
- React
- App Router
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Hook Form
- Zod
- generated typed API client from backend OpenAPI when available
- Vitest
- Testing Library
- Playwright for end-to-end tests

Use shadcn/ui as the primary UI component library.

Do not build a custom design system from scratch.

Prefer accessible shadcn primitives and consistent reusable application components.

---

# Product Experience

The application should feel closer to a native file manager than a marketing dashboard.

Priorities:

1. fast;
2. calm;
3. trustworthy;
4. predictable;
5. excellent for large file collections;
6. easy file sending.

Avoid excessive animations, gradients, gimmicks, AI branding, or overly dense enterprise UI.

---

# Main Navigation

Desktop web layout:

```text
┌─────────────────────────────────────────────────────────────┐
│ Logo                     Search                Account       │
├───────────────┬─────────────────────────────────────────────┤
│ My Drive      │                                             │
│ Received      │             Main content                    │
│ Sent          │                                             │
│ Shared        │                                             │
│ Recent        │                                             │
│ Favorites     │                                             │
│ Trash         │                                             │
│               │                                             │
│ Devices       │                                             │
│ Storage       │                                             │
├───────────────┴─────────────────────────────────────────────┤
│ 24.8 GB of 100 GB used                                     │
└─────────────────────────────────────────────────────────────┘
```

Responsive layouts should work well on tablets and mobile browsers, even though native mobile apps are planned later.

---

# Authentication

Implement:

- signup;
- login;
- email verification;
- forgot password;
- reset password;
- logout;
- session/device management.

During signup collect:

```text
email
password
username
display name
```

Username should be shown as:

```text
@anirban
```

Explain that users can send files directly to this identity.

---

# Onboarding

Keep onboarding short.

Suggested sequence:

## Screen 1

```text
Welcome

100 GB free.
Everything you need to store, sync and send files.
```

## Screen 2

Choose username:

```text
@__________
```

## Screen 3

Prompt:

```text
Upload your first file
```

Also show:

```text
Download the desktop app
```

Do not force tutorials.

---

# My Drive

Build a high-quality file browser.

Support:

- grid view;
- list view;
- breadcrumbs;
- sorting;
- folders;
- multi-select;
- drag and drop upload;
- upload folders where browser APIs allow;
- rename;
- move;
- delete;
- restore;
- favorite;
- download;
- send;
- share;
- details panel;
- version history;
- keyboard shortcuts.

Typical table columns:

```text
Name
Owner
Modified
Size
```

Use virtualized rendering if needed for large directories.

---

# Upload UX

Uploads must work for large files.

UI requirements:

```text
Uploading 3 items

video.mov          72%   8.4 GB / 11.6 GB
archive.zip        34%   1.2 GB / 3.5 GB
photo.jpg         Done
```

Support:

- pause where backend/protocol permits;
- resume;
- retry;
- cancel;
- progress;
- aggregate progress;
- upload errors;
- quota errors.

Do not freeze the UI while hashing or preparing large files.

Use Web Workers where useful.

---

# Storage Indicator

Always make storage usage understandable.

Example:

```text
24.8 GB of 100 GB used
```

Storage screen:

```text
Storage

24.8 GB used
75.2 GB available

Files      18.1 GB
Backups     5.9 GB
Trash       0.8 GB
```

Paid plan messaging should remain simple:

```text
Need more space?
Upgrade your storage.
```

Avoid feature comparison tables because features are not plan-gated.

---

# Received

This should be a first-class product surface.

Example:

```text
Received

Anirban
project-assets.zip
8.4 GB
Sent 3 minutes ago

[Accept] [Decline]
```

After acceptance:

```text
[Save to My Drive]
[Download]
```

Show:

- sender avatar;
- sender display name;
- sender username;
- file/folder name;
- size;
- sent time;
- current transfer state.

Filters:

```text
Pending
Accepted
Declined
```

---

# Send Flow

Sending should be extremely simple.

From a file context menu:

```text
Send
```

Open a dialog:

```text
Send "project.zip"

To
[ @username or email ]

Recent
@rahul
@priya
@john

[Send]
```

If account exists:

```text
Rahul Sharma
@rahul
```

If no account exists for an email:

```text
rahul@example.com
No account yet

They will be invited to create an account before receiving this file.
```

After sending:

```text
Sent to @rahul
```

or:

```text
Invitation sent to rahul@example.com
```

No public download link should be created.

---

# Sending Local Files from Web

Allow a user to choose a local file and send it.

The UX may appear as:

```text
Send a file
    ->
select local file
    ->
select recipient
    ->
upload to user's drive/storage
    ->
create transfer
```

Show storage implications before starting if the file cannot fit.

Example:

```text
This file is 18.4 GB.
You have 6.2 GB available.
```

Then offer:

```text
Upgrade storage
```

Do not offer a transfer-specific purchase.

---

# Sent

Show outgoing transfers.

Example:

```text
Sent

To @rahul
project.zip
8.4 GB
Accepted

To priya@example.com
photos.zip
2.3 GB
Waiting for account creation
```

Support:

- cancel pending transfer;
- inspect transfer status;
- resend invitation where appropriate.

---

# Sharing

Keep `Share` distinct from `Send`.

## Send

Recipient gets a copy.

## Share

Recipient gets access to the existing file/folder.

Share dialog:

```text
Share "Project"

Add people
[ username or email ]

Permission
[ Viewer v ]

People with access
Rahul Sharma     Viewer
Priya Sen        Editor
```

Everyone with access must authenticate.

No `Anyone with the link` option.

---

# Search

Implement metadata search.

Search should cover:

- filename;
- folder name;
- extension;
- path;
- basic filters.

Example:

```text
Search files

invoice
```

Filters:

```text
Type
Owner
Modified
Location
```

Do not implement AI content search.

---

# Recent

Show recently interacted-with files.

Track:

- opened;
- uploaded;
- downloaded;
- sent;
- received;
- edited metadata.

Keep this primarily server-driven.

---

# Favorites

Simple starred files/folders.

Support toggling from:

- list;
- grid;
- context menu;
- details panel.

---

# Trash

Support:

- restore;
- permanently delete;
- empty trash.

Clearly communicate permanent deletion.

Use destructive confirmation dialogs.

---

# Versions

File details should expose basic history:

```text
Version history

Today 10:22 AM
MacBook Pro
Current

Yesterday 8:14 PM
Windows PC

Sep 21
Web
```

Allow downloading an older version.

If backend supports restore-version, expose it.

---

# Devices

Device-management page:

```text
Your devices

MacBook Pro
macOS
Active now

Gaming PC
Windows
Last active 2h ago

Chrome on Web
Last active yesterday
```

Actions:

- rename device;
- revoke device/session;
- inspect last active time.

---

# Notifications

Build a notification center.

Events include:

- file received;
- transfer accepted;
- transfer declined;
- share invitation;
- new device sign-in;
- storage nearly full.

Use real-time backend events when connected.

Always reconcile with server state.

---

# Account Settings

Include:

```text
Profile
Username
Email
Password
Sessions
Devices
Storage
Billing
Security
Notifications
```

Keep billing focused on capacity.

---

# Billing UI

Example:

```text
Your storage

Free
100 GB

Need more?

500 GB
1 TB
2 TB
5 TB
10 TB
```

All plans:

```text
All product features included.
You only pay for more storage.
```

Do not create fake premium badges for basic functionality.

---

# File Preview

Implement safe previews for common formats where practical:

- images;
- PDF;
- text;
- audio;
- video.

Do not build document editing.

Unsupported types should show metadata and download action.

---

# Error Handling

Design explicit states for:

- offline;
- expired session;
- upload failed;
- insufficient storage;
- recipient unavailable;
- transfer cancelled;
- backend unavailable;
- duplicate filename;
- permission revoked.

Do not use generic `Something went wrong` messages when a useful explanation is available.

---

# Accessibility

Meet strong accessibility standards.

Requirements:

- keyboard navigation;
- visible focus states;
- semantic controls;
- screen-reader labels;
- adequate contrast;
- accessible dialogs;
- accessible menus;
- reduced-motion respect.

---

# Suggested Component Structure

```text
src/
  app/
    (auth)/
    drive/
    received/
    sent/
    shared/
    recent/
    favorites/
    trash/
    devices/
    storage/
    settings/
  components/
    ui/
    app-shell/
    drive/
    transfer/
    share/
    upload/
    storage/
    notifications/
  hooks/
  lib/
    api/
    auth/
    upload/
    format/
  stores/
  types/
  tests/
```

Use shadcn/ui components for:

- dialogs;
- dropdown menus;
- context menus;
- sheets;
- tooltips;
- buttons;
- inputs;
- command palette;
- tables;
- progress;
- alerts;
- badges;
- tabs;
- toasts.

---

# Keyboard UX

Implement useful shortcuts:

```text
Cmd/Ctrl + K   Focus search / command palette
Cmd/Ctrl + U   Upload
Delete         Move selected item to trash
Enter          Open selected item
F2             Rename
Esc            Close current overlay
```

Avoid overriding standard browser shortcuts unnecessarily.

---

# Command Palette

Use shadcn `Command`.

Example:

```text
Upload file
Create folder
Go to My Drive
Go to Received
Send selected item
Share selected item
Open storage
```

This is optional for initial vertical slice but should fit the component architecture.

---

# State Management

Use:

- TanStack Query for server state;
- local React state for component state;
- a small store only where cross-cutting local state genuinely requires one.

Do not duplicate backend state unnecessarily.

Uploads may use a dedicated upload manager.

---

# API Integration

Create a typed client around backend APIs.

Organize modules:

```text
auth
users
devices
drive
uploads
downloads
transfers
shares
sync
notifications
billing
```

Use consistent handling for:

- auth refresh;
- retries;
- cancellation;
- error mapping;
- request IDs.

---

# Testing

Implement tests for critical UI flows.

## Component tests

- send dialog;
- recipient search;
- upload progress;
- quota warning;
- received transfer;
- share dialog;
- trash confirmation.

## Playwright flows

### Flow 1

```text
signup
upload file
file appears in My Drive
download file
```

### Flow 2

```text
Alice logs in
Alice sends file to Bob
Bob logs in
Bob sees Received
Bob accepts
Bob saves file to drive
```

### Flow 3

```text
Alice sends to unregistered email
recipient signs up
recipient verifies account
transfer appears
```

### Flow 4

```text
user reaches storage quota
upload is blocked
upgrade-storage UI is shown
```

---

# Performance

Optimize for large datasets.

Requirements:

- lazy load folders;
- paginate or cursor directories;
- avoid fetching file contents unnecessarily;
- use thumbnails where available;
- do not block rendering on large upload hashing;
- cancel obsolete API requests;
- use optimistic updates selectively;
- use virtualization for very large lists.

---

# Security

Frontend must:

- never expose object-storage credentials;
- never construct permanent public object URLs;
- respect backend authorization;
- sanitize rendered filenames;
- avoid unsafe HTML rendering;
- avoid storing sensitive auth material in insecure local storage if cookie-based auth is available;
- handle signed download/upload URLs as short-lived credentials.

---

# Implementation Order

## Phase 1

- Next.js scaffold;
- shadcn/ui;
- app shell;
- auth;
- onboarding.

## Phase 2

- My Drive;
- folder browsing;
- file upload;
- download;
- storage usage.

## Phase 3

- Send flow;
- Received;
- Sent;
- invitations.

## Phase 4

- sharing;
- Recent;
- Favorites;
- Trash;
- versions.

## Phase 5

- devices;
- notifications;
- billing/storage upgrades;
- polish.

---

# Visual Acceptance Criteria

The product should look polished enough to plausibly launch.

Specifically:

- consistent spacing;
- restrained typography;
- excellent empty states;
- useful loading skeletons;
- clean context menus;
- responsive dialogs;
- large-file progress UX;
- no obvious template/demo appearance;
- no placeholder lorem ipsum;
- no unfinished navigation entries.

Use realistic seeded development data.

---

# Definition of Done

Do not stop after scaffolding.

The web application is complete for this milestone when:

- signup/login work against the backend;
- the user sees 100 GB free storage;
- files and folders can be uploaded and managed;
- large upload progress is visible;
- files can be downloaded;
- transfers can be sent to users;
- transfers can be addressed to unregistered email recipients;
- unauthenticated users cannot access transfers;
- Received and Sent surfaces work;
- accepted files can be saved to the recipient's drive;
- authenticated sharing works;
- public anonymous sharing does not exist;
- storage upgrade UI only sells additional capacity;
- shadcn/ui is used consistently;
- responsive layouts work;
- Playwright critical flows pass;
- unit tests pass;
- linting and type checking pass.

Continuously run the application, tests, linting, and type checking while implementing. Fix errors before proceeding. Prefer complete end-to-end flows over disconnected mock screens.

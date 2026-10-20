# Device activity reporting

Status: building (2026-10-18). Desktop first; iOS and Android later.

## Why

Pausing a backup or sync only happened inside the desktop app. The server kept the backup run
`RUNNING` and the folder `ACTIVE`, so the console showed a paused backup as stuck, and the owner
kept getting "your backup is out of date" reminders for folders they had paused on purpose. Sync
told the server nothing at all: not when it started moving files, not when it finished, not when
it stopped because storage was full.

The desktop app now reports what it is doing, for sync folders, backup folders and the engine as
a whole, and the server keeps each one's current status.

## What is reported

Each event is about one **subject**:

| Scope    | Subject                              | `folderId`                         |
| -------- | ------------------------------------ | ---------------------------------- |
| `ENGINE` | the app's sync and backup engine     | none                               |
| `SYNC`   | one synced folder on this device     | the folder's cloud item id         |
| `BACKUP` | one backup folder on this device     | the backup id (`BackupRoot.id`)    |

The app works out each subject's **status** and reports an event only when it changes:

| Status    | Engine                                   | Sync folder                       | Backup folder                     |
| --------- | ---------------------------------------- | --------------------------------- | --------------------------------- |
| `PAUSED`  | "Pause sync and backups" is on           | paused, or everything is paused   | paused, or everything is paused   |
| `BLOCKED` | can't run: storage full, account locked  | its folder can't be read          | its folder can't be read          |
| `ACTIVE`  | running                                  | moving files (see below)          | a backup run is open              |
| `IDLE`    | –                                        | nothing to send or fetch          | no run open                       |

Precedence is `PAUSED`, then `BLOCKED`, then `ACTIVE`, then `IDLE`. The engine being blocked
doesn't change folder statuses: the console shows the engine's status next to them.

The event's **action** says what happened, from the old status to the new one:

| From → to                 | Action      |
| ------------------------- | ----------- |
| anything → `PAUSED`       | `PAUSED`    |
| `PAUSED` → anything       | `RESUMED`   |
| anything → `BLOCKED`      | `BLOCKED`   |
| `BLOCKED` → anything      | `UNBLOCKED` |
| `IDLE` → `ACTIVE`         | `STARTED`   |
| `ACTIVE` → `IDLE`         | `FINISHED`  |

A subject first seen reports `STARTED`, `PAUSED`, `BLOCKED` or (for `IDLE`) `IDLE`, so the server
learns every subject's status once.

### Reasons

`reason` says who or what caused `PAUSED` and `BLOCKED`:

- `USER`: the person paused this folder.
- `ALL`: the person paused everything ("Pause sync and backups").
- `APP`: the app paused it itself (a sync folder whose cloud folder is gone, a revoked device).
- `STORAGE_FULL`: the account has no storage left, so nothing can upload (engine `BLOCKED`).
- `LOCKED`: the account's encryption is locked on this computer (engine `BLOCKED`).
- `UNAVAILABLE`: the folder can't be read: its drive isn't connected, its network share
  disconnected or stopped answering, it was moved or deleted, or harbor0 lost permission to it
  (folder `BLOCKED`). It carries on by itself once the folder can be read again.

### A file that can't be read

When a backup can't read a file for any reason other than the file being gone, the app first
checks the backup folder itself (giving a network share 15 seconds to answer):

- The folder can still be read: only that file is set aside, with its error, for the next run,
  and the run goes on with the rest. A brief hiccup or one unreadable subfolder no longer stops a
  backup.
- The folder can't be read: the run stops there and stays open, nothing is marked failed, and the
  folder shows "“library” can't be read right now. Its drive or network share may have
  disconnected." (`FOLDER_UNAVAILABLE`) instead of the system's error, and reports `BLOCKED` /
  `UNAVAILABLE`. It goes on from the same file once the folder can be read.

### Counts

Counts are numbers only; events never carry file or folder names.

- Sync `STARTED`: `files`, the files waiting to send or fetch.
- Sync `FINISHED`: `files`, the files sent or fetched since it started; `failed`, the folder's
  file problems listed in the app.
- Backup `STARTED`: `files` and `bytes` the run plans to save (`plannedFileCount`,
  `plannedSizeBytes`); `runId`.
- Backup `FINISHED`: `files` and `bytes` saved; `runId`.

### When a sync folder is "active"

A sync folder is `ACTIVE` while it has jobs queued or a file transferring. It becomes `IDLE` only
after 30 seconds with nothing to do, so a burst of edits is one `STARTED`/`FINISHED` pair rather
than dozens.

## How it is sent

- The app keeps unsent events in its journal (at most 500; the oldest go first) and sends them
  in batches of up to 50 to `POST /v1/activity`, after each engine pass and within a few seconds
  of a change. Events made while offline are sent when it is back, with the time they happened.
- Each event has a random `id` and the time it happened, `at`. Sending the same events again is
  harmless.
- What the app last reported for each subject is kept in its journal, so a restart doesn't
  report everything again; a subject that disappears (folder removed) is forgotten.
- A server without the route (404) drops the queue and the app stops reporting until restarted.

## What the server does

`POST /v1/activity` with `{ events: ActivityEvent[] }` (1–50), signed-in devices only.

1. **Logs every event** as one `activity` line with the account, device, platform and app
   version, like a request line. The console reads these for its timeline (kept 30 days). No
   database write.
2. **Keeps each subject's current status** in one row under the account,
   `ACTIVITY#<device>#<scope>#<folderId or ->`, where `<device>` is the installation key
   (`installation:<devicePublicId>`, or `session:<deviceId>`, as for sync folder lists). The row is
   written only when the status or reason changes, and only by an event newer than the one it
   holds (events can arrive late or out of order). Fields: scope, folderId, deviceId, status,
   reason, since (the event's time), files, bytes, failed, runId.
3. **Pauses backup folders**: a `BACKUP` event moving to `PAUSED` sets the backup folder's state to
   `PAUSED`; moving away from `PAUSED` sets it back to `ACTIVE`. Only `ACTIVE`/`ERROR` become
   `PAUSED`, and only from the device that owns the backup. A paused folder:
   - still takes writes from its device (nothing checks for `ACTIVE`), so a run carries on as soon
     as the app resumes, even before its `RESUMED` arrives;
   - gets no stale-backup reminders (`watchedBackup` is `ACTIVE` or `ERROR` only).

   A run starting on a `PAUSED` folder sets it back to `ACTIVE`, in case the `RESUMED` was lost.
4. Answers `{ accepted }`. Unknown folders and other devices' backups are logged but change no
   status or state.

Write cost: one small transaction per status change. A sync folder that is edited all day costs
about two per burst of edits.

## Console

- **Backups page**: each backup folder shows its device's reported status: **paused** (by the
  person, or everything paused), **storage full**, or **locked**, instead of "not saving". A
  running run whose folder is paused says so and shows no stall warning.
- **Sync page** (`/user/sync?id=`, linked from the account): each device's synced folders with
  their current status (syncing, up to date, paused), when it last changed and the last counts,
  plus the engine's status per device.
- **Activity timeline** on both pages: the account's recent `activity` lines (7 days): time,
  device, folder, action, reason and counts.
- Folder names are the top-level synced or backed-up folder only, as on the backups page; nothing
  inside them is ever shown. An encrypted account's names show as "Encrypted folder".

## Not covered

- iOS and Android (on the `mobile` branch).
- Whether a device is online right now: the console shows when it last reported.
- Signing out: the session is gone, so the app can't report it; the device list already shows
  signed-out devices.

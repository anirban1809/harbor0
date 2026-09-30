# Desktop app screenshot coverage

353 PNG screenshots from the current harbor0 Electron desktop build (0.1.1), captured on macOS with isolated profiles and mock data.

Open **index.html** for the searchable gallery. Screenshots are grouped in numbered page folders. **manifest.json** lists every image and its state tags.

## Pages

| Page | Screenshots |
| --- | ---: |
| Sign in | 6 |
| My Drive | 163 |
| Shared (Received and Sent tabs) | 31 |
| Trash | 16 |
| Backups | 29 |
| Devices | 9 |
| Sync | 64 |
| Storage | 9 |
| Settings | 26 |

## Captured states

- Sign in: ready, entered credentials, signing in, incorrect credentials, missing connection configuration.
- My Drive: Cloud, Backup, and Sync tabs; list/grid; filters and sorting; selection and bulk actions; folder browsing; new folder; rename; send; share and permissions; move; details; version history; restore locally; copy to cloud; disconnect backup; remove from sync; trash confirmation; empty, filtered-empty, loading and errors.
- File previews: text, image, audio, video, empty text, truncated large text, unsupported type, corrupt media, loading, error and retry.
- Shared → Received and Sent: pending, accepted, saved, preparing, preparation failure, expired, cancelled, signup pending, pagination, empty/loading/error states; incoming transfer and sync invitation dialogs.
- Trash: populated, empty, loading and errors; item menus; rename/send/trash dialogs; permanent deletion and Empty Trash confirmations.
- Backups: archive browser, nested folders, saved versions, restore confirmation plus pending/completed/failed restores; running/completed/partial/failed backup history and run details; active/paused/error/disconnected folders; folder options, disconnect confirmation, empty and error/loading states.
- Devices: active and revoked devices, empty/loading/error states.
- Sync: Synced Folders view; flat folder table with local folder opening and disk usage; downloading, paused, offline and empty states; floating action banner; global notifications with invitations, recent activity, and recovery actions; add/setup folder, change local folder, folder details, exclusions, conflict review, remove from sync, sharing, invitation acceptance, access removal and invitation sent states. Light/dark captures and 390–1440 px window sizes.
- Storage: usage with reserved uploads, empty usage, near capacity, full, unavailable.
- Settings: light/dark/system controls, preset themes, custom colors and validation, notification error.
- ZIP download status: queued, listing, building, downloading, finalizing.
- Responsive samples: desktop, narrow desktop, and compact app window sizes; light and dark samples.

## Boundaries

These are screenshots of the desktop application, not web-app substitutes. Backend responses and local-folder selections were mocked; no real account, cloud files, or user folders were modified. Preview media uses local test fixtures.

The gallery covers the app states and dialogs listed above, rather than every possible combination of file, permission, network condition, theme and window size. macOS-owned file/folder pickers, save dialogs, keychain prompts, system settings windows and native notification banners are not included. Native notifications were simulated to capture the in-app dialogs they open.

Full-page captures include scrollable page content; dialogs and menus are captured at the current viewport size to preserve their actual placement.

## Dialog inventory

### My Drive

- Archive.zip
- Brand guidelines.pdf
- Broken.webm
- Clip.webm
- Copy to cloud?
- Disconnect backup?
- Empty.txt
- File details
- Large.log
- Move 3 items to trash?
- Move Launch kit
- Move README.md to trash?
- Music.wav
- Notes.txt
- Photo.png
- Project notes.md
- Remove “Projects” from sync?
- Rename Launch assets
- Restore this local file?
- Retry.txt
- Send Project notes.md
- Share 2 items
- Share Project notes.md
- Slow.txt
- Version history

### Received

- Content received
- Sync “Shared team folder”

### Favorites

- Move to trash?
- Rename item
- Send to a person

### Trash

- Delete permanently?
- Empty Trash?

### Backups

- Disconnect backup?
- Folder options
- Restore this version?

### Sync

- Add folder to sync
- Change local folder
- Folder details
- Manage exclusions
- Notes.md
- Remove from sync “Team workspace”?
- Remove from sync “editor”?
- Review conflict
- Set up folder sync
- Share “Team workspace”
- Sync “Launch documents”

Activity drawer and the annotated selection, cloud menu, and Sync screenshots refreshed on 2026-09-29. Includes empty, completed, failed, and compact activity views.

Shared screenshots refreshed on 2026-09-29 from the current desktop build: 18 Received and 13 Sent views, covering both themes, 1440/1024/768/390 px widths, populated/empty/loading/error states, accepted and saved transfers, pagination, cancellation, incoming content and sync invitation dialogs. Replaces the former standalone Received and Sent page screenshots.

Favorites page removed from both clients; its gallery section has been removed. Shared screenshots show the updated navigation. Older captures of other pages remain historical views.

Sync screenshots refreshed on 2026-09-29: Synced Folders tab, My Drive table style, no introductory banner or section messages, and invitations/recovery actions in the notifications drawer with a floating action banner. All 64 Sync images are current.

Sync Activity tab removed on 2026-09-29. Recent sync updates remain in notifications; all Sync gallery images refreshed.

The remaining Synced Folders tab header was removed on 2026-09-29. Sync content now appears directly below the page header. All 64 Sync screenshots have been refreshed.

Sync table updated: folder names open on the device; Folder size reports disk usage; status uses badges; Contents, Changes, Exclusions, and Actions columns removed. Folder management remains in the folder-name menu. Collapsible help and its separator removed. All 64 Sync screenshots refreshed, including calculating/unavailable folder-size states.

My Drive refreshed on 2026-09-29: Device names in the Sync table (including nested folders); explicit Type and Modified selections; full sort direction; highlighted active filters and Clear filters. Includes 19 current light/dark, compact-window, active-filter, and sort-menu views. Earlier dialog/state captures remain historical.

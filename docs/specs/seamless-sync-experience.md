# Seamless sync experience

Design proposal · 29 September 2026 · Not yet implemented

## Simplified interaction, revised after feedback

This revision takes precedence over the presentation details below. Keep the underlying delivery and recovery rules.

- The whole everyday flow is: **choose a folder once, then use your files normally**.
- My Drive is the primary surface. Sync remains a secondary management page showing the same folders; users never need to visit it to complete routine delivery.
- Show one quiet overall sync status. Healthy folder rows have no repeated badges, local paths, receipt counts, last-check timestamps, or device panels. Reveal details only on request. A folder with a specific problem can carry its own actionable state.
- For a folder missing locally, show **Sync to this device** directly on its row. A single destination sheet finishes setup. On phones, offer the app's persistent storage as the default.
- Remove the conflict notice as well as the review dialog. Preserve divergent edits as ordinary, clearly named files, e.g. **Report (iPhone edit).docx**, with optional provenance in file details. No acknowledgement is required. This does not pretend that incompatible edits were combined.
- Keep pause, location changes, device management and recovery inside their existing menus or settings. Recovery stays accessible through Version history and Trash. Storage accounting remains visible on Storage.
- Only interrupt when the user can fix a real blocker, such as a full disk or missing permission. Offline delivery remains a neutral waiting state and retries automatically.

The revised inline proposal intentionally omits device and activity panels, the conflict banner, duplicate per-file status labels, and permanent local paths. Preview controls sit outside the depicted product and are not proposed app UI.

## Product promise

Change a file on one device. Harbor updates the other devices automatically when they can connect and run sync. Users select local destinations once; routine delivery, retries, recovery retention, and receipts require no decisions.

The normal experience is opening files in My Drive or their usual local folders. Sync is a place to check availability and manage destinations, not a required step in daily work.

## Findings in the current UI

Reviewed current desktop and mobile source and saved desktop screenshots from 28 September.

- `apps/desktop/src/sync-page.tsx`: the page is built around local roots, with prominent local paths, sizes, last-sync timestamps, and Pause. Setup copy explains temporary cloud storage and acknowledgements. The conflict dialog asks users to review versions on other devices and mark the notice reviewed.
- `apps/desktop/src/sync-state.ts`: preserved conflicts become Conflict and elevate the whole app to Action required. Transient job errors also become Action required.
- `apps/desktop/src/sync-notifications.tsx`: publishes individual upload/download events and routes conflicts through the action-required flow.
- `apps/desktop/src/sync-page.tsx`: Remove from sync stops an owned folder on all linked devices; shared-folder removal behaves differently. The label does not reveal this scope.
- `apps/android/app/src/main/java/app/harbor0/android/WorkspaceModel.kt`: opening released content requests it and tells the user to refresh after a computer uploads it.
- `apps/ios/Harbor0/CollectionsView.swift` and Android MainActivity: describe phones as browsers for desktop sync, with device-confirmation counts in folder rows. Full phone replication is a functional addition, not a copy change.

## Visual direction

Keep Harbor's established neutral design and bundled Inter/Roboto typography. No navigation overhaul or decorative dashboard. Proposed reference tokens: white #FFFFFF, surface #F6F5F4, ink #292825, muted #6A6762, action #59554E, success #287553; use existing semantic theme and custom appearance settings in production, with corresponding dark values. Type hierarchy: 28px page title, 16px folder name, 14px controls/body, 12px secondary detail. Keep text left aligned.

Use the folder row as the main unit. Put location underneath the name; place one status and the next useful action alongside it. On narrow screens the action wraps below without hiding essential status. A folder appears once in each relevant view, backed by the same identity and state.

Review against the brief: replacing the existing table with dashboard cards would add scanning and visual noise. Retain the quiet list and improve information priority. The distinctive interaction is that every row answers: is this here, and will it catch up?

## First folder

1. Select **Add folder** from Sync, or **Sync this folder** from an eligible folder in My Drive.
2. Choose a folder through the native picker. It stays where it is; Harbor must not unexpectedly move it.
3. Show folder name, location and one sentence: **Changes in this folder update your other devices automatically.** Show **Start syncing**.
4. Start background work and close setup. The row progresses from Preparing to Syncing to Up to date. Do not require an Upload or Sync now action.
5. Keep deletion behaviour in concise secondary copy: **Deleting a file also deletes it on your other devices. Recover recent changes for 24 hours.** Move cloud implementation details to Storage and help.

## New device

Registration automatically requests a current snapshot from available holders, without waiting for a destination selection. Reuse staged content where possible. If no holder is reachable, queue the request. Registration cannot make an offline-only file immediately available.

Both My Drive and Sync show every account sync folder immediately. A catalog placeholder is not evidence that the contents are available locally or in the cloud.

Offer a single optional onboarding action: **Set up sync on this device**. On desktop, choose a base location once, with the default under the user's home folder. Preview the resulting subfolders and total known download size. Keep **Change location** available per folder. The user's existing **Sync to this device** action remains available on every unconfigured folder and opens the same destination flow. Default to creating a new subfolder to avoid silently mixing unrelated existing files.

After setup, automatically place newly added account sync folders under that base location, with a deterministic collision-safe name. Folders originating on this device keep their original location. On phones, propose a persistent app-managed destination in the setup sheet; expose native location selection only where supported. Do not store acknowledged replicas in an evictable preview cache.

Before setup: **Not on this device** with **Sync to this device**. After setup: **Preparing**, **Downloading**, or **Waiting for MacBook**. A queued request finishes without manual refresh. Never remove/recreate the folder row as it changes state.

Under the agreed policy, every registered sync device owes receipt of every folder. An unconfigured, paused, offline, or full device therefore retains pending cloud content. Do not silently introduce selective sync or count a phone's preview cache as complete delivery. Phone storage limits are a genuine tradeoff of this policy. A future ability to exclude a device/folder requires an explicit membership-policy change.

## Everyday behaviour

- Save locally first and persist the outgoing work queue. Wait for a stable file snapshot rather than uploading partially written bytes.
- Upload automatically. Other devices retrieve, verify, and durably install the change, then acknowledge it.
- Avoid replacing a locally modified file with incoming content. Compare the version the edit was based on; preserve divergent work.
- Refresh visible lists in place, retaining selection and scroll. File previews may refresh when safe; never take over the current editor or steal focus.
- Resume interrupted work and retry temporary failures automatically. Keep working folders moving if another folder is blocked.
- No successful-sync toasts, mandatory refresh, repeated offline warnings, or per-file notification flood. Keep detailed transfers under expandable activity.
- Phones use native background transfer support and catch up on foreground entry; do not promise immediate delivery while the OS prevents work. Bytes received and files verified/installed are distinct stages.

## Honest, quiet status

| Condition | User-facing status | Treatment |
| --- | --- | --- |
| All required devices confirmed the known current state | Up to date | Quiet check |
| This device is actively transferring or applying files | Syncing… | Progress only when useful |
| Local edits not yet safely staged | Saved on this device | Offline detail if relevant |
| Local edits staged, another device offline | Saved · Waiting for iPhone | Neutral; no endless spinner |
| New device has no available source yet | Waiting for MacBook | Explain that sync starts automatically |
| Destination not chosen | Not on this device | Sync to this device |
| User paused | Paused | Resume |
| Permissions, storage, or authentication require intervention | Specific problem, e.g. Allow folder access | One targeted action |

An Up to date label must be scoped clearly: **This device is up to date** can be local; unqualified account-level Up to date requires all required acknowledgements. Never infer delivery from an empty local queue. A new destination waiting for content is different from an existing destination waiting for another device to receive its changes.

## Concurrent edits without a conflict task

The product must not silently discard an edit to hide complexity. Generic files cannot reliably have their contents merged; in particular, arbitrary documents, images, archives, and databases need file-type-aware handling.

| Situation | Automatic policy |
| --- | --- |
| Changes to different files | Apply both |
| Identical content on two devices | Deduplicate |
| A new edit descends from the current version | Advance that file normally |
| Two different edits descend from the same older version | Preserve both as ordinary synced files |
| Delete and edit occurred independently | Apply deletion to the original; preserve the changed content as a named saved copy |
| Safe structural rename and independent content edit | Combine only if stable identity and path constraints make it unambiguous; otherwise preserve both |

For divergent edits, retain the already accepted version under the original name and give the other an understandable name, e.g. **Report (iPhone edit).docx**. Assign this centrally and idempotently so all devices converge on the same pair without duplicate cascades. Do not choose a winner using device wall clocks or interpret a late upload as necessarily the latest intended edit.

Record the preservation in optional file history, without a separate conflict notice or task. Both ordinary files appear in the folder automatically. No red Conflict badge, review modal, Mark reviewed task, or pause of the sync queue. Do not claim the documents were combined.

The extra file is a current user file, not an expiring recovery version. It remains until the user removes it and counts as normal content. That visible duplicate is the limited friction required to preserve incompatible edits without demanding a decision. Automatically merging supported structured formats can be a later enhancement with separate correctness requirements.

## Recovery and cloud storage

Retain the agreed policy: staged changes are not eligible for cleanup until all registered sync devices confirm required delivery and the applicable 24-hour recovery window expires.

Before committing a destructive overwrite or deletion, durably retain the old bytes needed to undo it. Start its 24-hour recovery window when that recovery record and content are safe in the cloud. Never advertise a recovery deadline unless the necessary content is actually retained. If preservation fails, queue that destructive propagation and explain the real blocking condition. Recovery expiry may occur before a long-offline user sees a change; the app must not promise otherwise.

My Drive offers **Recent changes** and per-file **Version history**. Deleted items remain recoverable in Trash for the same sync recovery window. **Restore** publishes a new change and propagates normally. Show the actual expiry when inspecting a recoverable item, not a countdown on every folder.

Storage groups unique physical content into **Waiting for devices** and **24-hour recovery**. If a blob serves both purposes, count it once under Waiting for devices and expose both reasons in details. Reclassify after receipt; clean up automatically after eligibility. Let users identify the device preventing cleanup and remove an obsolete device explicitly. Never silently expire undelivered content, auto-remove a device, or call cloud-retained bytes free storage.

## Safer management actions

- **Pause on this device** temporarily stops local work, preserves local files, and still owes delivery.
- **Change location** remaps this device with a preview; it must not treat the old location disappearing as mass deletion.
- **Stop syncing on all devices…** explicitly names the scope and preserves local files, matching the current owned-folder behaviour.
- **Delete for all devices…** is separate and recoverable for the agreed period.
- **Remove device…** explicitly ends that device's delivery obligations; returning devices enroll and request a current snapshot again.

Do not add a deceptively local Stop syncing action that silently waives this folder's receipt on one device: that would alter the agreed all-device policy. A future per-folder opt-out can be designed separately.

## Priorities

1. Implement one account catalog and consistent availability model for My Drive and Sync, including unconfigured devices. Preserve identical folder identity across views.
2. Implement durable staged delivery, new-device snapshot requests, verified receipts and race-safe cleanup. A concurrent new registration must not lose its required snapshot to cleanup.
3. Replace blocking conflict presentation with automatic keep-both handling, shared identity/naming, and optional viewing. Persist both edits before clearing any actionable error.
4. Make phone sync a real persistent replica with background scheduling, disk-space handling and durable receipts. Replace request-and-refresh with automatic completion. UI copy must follow capability.
5. Simplify setup, folder rows and notification policy. Move Pause, exclusions, device counts and technical detail out of the main path.
6. Add the 24-hour recovery workflow and transparent storage breakdown without changing the retention guarantee.

## Acceptance scenarios

- Save on A while B is available: B updates without a click, toast, or manual refresh.
- B is offline: A shows saved/waiting; B reconnects and catches up; the cloud does not delete its pending data.
- C registers while A and B are offline and no content is staged: folders appear, requests wait, and downloads resume when a holder returns.
- Choose one base location on C: folders download into the shown locations; later account folders use that base automatically.
- Two devices edit the same original offline: both contents survive, every device gets the same pair, and no review step is required.
- Delete on A while B independently edits: B's work survives as a saved copy; unrelated files keep syncing.
- An overwrite/delete reaches everyone in five minutes: recovery remains until the actual 24-hour deadline.
- A device is offline beyond 24 hours: required delivery content remains, while expired recovery-only history may be removed.
- Disk full, revoked permissions or expired authentication: the specific folder/device has a direct repair action; healthy folders continue.
- A root folder or external disk disappears: treat as unavailable, never as a request to delete all remote files.
- The app restarts or the phone is suspended mid-transfer: no premature receipt; verified work resumes without duplicate files.

The inline proposal demonstrates selected UI states only; these acceptance scenarios require implementation and end-to-end validation.

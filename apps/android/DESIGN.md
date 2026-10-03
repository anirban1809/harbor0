# Android workspace

The Android app follows the web and desktop interface described in [docs/UI.md](../../docs/UI.md): the same tokens, type, icons and component shapes, laid out for a phone. Navigation, the document picker, file sharing and Back stay native.

Tokens mirror `apps/web/app/styles/tokens.css`. Five colors per mode can be customised (accent, background, cards, navigation, borders); text, fills, tints and status tones are derived in Oklab against whichever surface an element paints (`Theme.kt`, `SurfaceTokens`). The default Harbor theme is indigo `#4353d9` on white with a `#f4f5f7` navigation canvas; Ocean, Forest, Violet and Sunset match the web presets, each with a dark palette.

Type is Geist and Geist Mono, bundled as variable fonts in `res/font`. Sizes are in `sp` and follow system font scaling: 20 semibold page titles, 15 medium file names, 12–13 metadata. Icons are lucide, generated into `Icons.kt` by `generate-icons.mjs`.

Shell: the phone layout of the web app (`apps/web/app/styles/mobile.css`). A top bar on the page color holds the brand mark, a pill search field, the activity bell and the avatar menu; a bottom tab bar (Drive, Shared, Backups, Trash, More) has a hairline on top and marks the active tab with an accent-soft pill behind its icon. Pages have a 16dp gutter and a 24sp title. More, item actions, details, versions and every dialog are bottom sheets with a grab handle and 20dp top corners; dialog actions stack full width, primary first. My Drive's root lists cloud files after three pinned virtual folders (Synced Folders, Backups, Archives; no selection or actions) that open to one folder per device, then that device's folders. My Drive has a floating 56dp “New” button that turns into a selection dock while items are selected. Sign-in puts the brand and tagline on the navigation color and the form on a sheet.

    [◉] (  Search your files   )  🔔  (A)
    My Drive
    5 items                      [≡|⊞]
    (Type: All items ⌄) (Modified ⌄) (Sort ⌄)
    ☐ Name
      [⟳] Synced Folders                 ›
      [▣] Backups                        ›
      [▦] Archives                       ›
    ☐ [▢] Documents                    ⋯
          Folder · Sep 30, 2026
    ☐ [▤] Project brief.pdf      ★     ⋯
          2.5 MB · Sep 30, 2026      [+]
    ─────────────────────────────────────
     Drive  Shared  Backups  Trash  More

UI files: `Shell.kt` (frame, top bar, tab bar, floating cards), `DriveScreen.kt`, `SharedScreen.kt`, `BackupsScreen.kt`, `TrashScreen.kt` (and in-place search results), `SyncScreen.kt` (Sync page and its sheets), `MoreScreens.kt` (Devices, Storage, Notifications, Settings), `AuthScreens.kt`, `Sheets.kt`. State lives in `WorkspaceModel.kt`, `DriveModel.kt`, `PagesModel.kt`, `SyncModel.kt` and `Uploads.kt`.

Sync follows the desktop sync page (`apps/desktop/src/sync-page.tsx`) in phone form. The Sync page opens from More and from the “This phone” card at the top of My Drive → Sync. It shows a status card (Up to date, Syncing, Paused, Offline, Action required, Waiting for another device, with the transfer in progress), “Sync a folder”, Pause/Resume and Sync now, then cards for Needs attention, On this phone, Waiting for another device, Shared with you, On your other devices, Recent activity and Backups from this phone. Each folder row opens a sheet with its details and actions (pause, exclusions, change local folder, share, stop syncing on this phone, remove from sync everywhere). Setup is one sheet: choose the folder on the phone (system folder picker), then for a new folder either let harbor0 create a cloud folder named after it or browse My Drive and pick or create one. Backups detail pages show this phone's controls (Back up now, Pause, Exclusions, Archive / Restore archived folder, Disconnect) only for folders backed up from this phone; folders from other devices stay read-only.

    Sync
    ┌ [▯] Sync on this phone      (✓ Up to date) ┐
    │     2 folders · Checked just now            │
    └─────────────────────────────────────────────┘
    [ + Sync a folder ] [ ‖ Pause ] [↻]
    On this phone
    ┌ ▢ Camera              (Syncing) › ┐
    │   My Drive / Phone / Camera       │
    │   128 files · Synced 2 minutes ago│
    └───────────────────────────────────┘

Components live in `Kit.kt` and `PhoneKit.kt` (sheets, chips, checkboxes, FAB, selection dock) and correspond to `apps/web/components/ui`: buttons (primary, outline, ghost, danger, link), bordered inputs with a focus ring and a label above, segmented control, badges, cards, alerts, progress, skeleton rows, menus, dialogs, empty states and the toast. Use them rather than Material components so heights, radii and borders stay consistent. Controls are 44dp (36dp small) with 48dp touch targets; radii are 6/8/12/16dp. Content is capped at 840dp on tablets.

States: skeleton rows on first load, the current list stays visible during background refreshes, failed loads show a retry state instead of an empty one, and confirmations use a danger button. Appearance changes apply at once and are saved to the account in the background, with a retry if saving fails.

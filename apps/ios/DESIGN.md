# Mobile workspace and appearance

The iPhone app is the web app's phone layout (viewport < 760px, `apps/web/app/styles/mobile.css`) rebuilt natively in SwiftUI. When the web phone UI changes, change this app the same way.

**Frame.** A sticky translucent top bar: 26pt brand mark, pill search (“Search your files” / “Search Trash”), bell with unread dot (activity sheet → Notifications), and a round avatar opening the account menu. A five-column bottom tab bar — Drive · Shared · Backups · Trash · More — with the active icon in an accent-soft pill. More is a bottom sheet with Devices, Storage, Settings, the theme toggle and the storage card; while one of those pages is open, More is the active tab.

**Pages.** 16pt gutters, a 24pt semibold page title, then content. Cards have a 1pt border, 12pt radius and 16pt padding. Every dialog and menu is a bottom sheet (20pt radius, grab handle, title and close X, full-width actions with the primary on top of Cancel). Toasts and the upload tray float above the tab bar, and above the FAB on My Drive.

**My Drive.** Title, pinned “Synced Folders”, “Backups” and “Archives” rows first at the root (devices, then each device’s folders there), item count with list/grid switch, a sideways row of filter chips, breadcrumbs inside folders, then 64pt rows (checkbox, 40pt kind tile, 15pt name over “size · date”, favorite star, sync badge, “⋯”). A 56pt accent FAB opens the new menu; with a selection a floating dock replaces it.

**Tokens.** `Theme.swift` mirrors `tokens.css`: five customisable colors per mode (Harbor is indigo on neutral: light primary #4353d9 on #ffffff, dark #8793ff on #141518) plus fixed status colors. Text, fills, accent-soft/text and status tints are derived per surface with the same Oklab mixes as `color-mix(in oklab, …)`, so custom palettes stay readable. Preset and custom colors save to the account and are shared with web and desktop.

**Type and icons.** Geist (bundled variable font, weights via the `wght` axis) at the web's sizes: 24 titles, 16 sheet titles, 15 file names, 14 body, 13 secondary, 12 meta, 11 tab labels. Icons are lucide paths generated into `Lucide.swift` by `generate-icons.mjs` and drawn with a 2/24 round stroke.

**Native differences.** File preview uses Quick Look; downloads and folder ZIPs open the share sheet (Save to Files). Folder upload uses the Files folder picker. Filter selects use native menus, like the web's native `<select>`; action menus are web-style bottom sheets. Long-press selects a row.

**Sync and backups on this iPhone.** The Sync page follows the desktop sync page at phone size: a “This iPhone” status card (status badge, current transfer with progress, Sync a folder / Pause / check now), Needs attention cards, Invitations, “On this iPhone” folder rows (status badge, files · last synced) that open a bottom-sheet menu, “Syncing on other devices” with *Sync here*, and Recent activity. Setup is one tall sheet: choose the cloud folder, then the location (harbor0’s folder in Files is the recommended default; Choose a folder… opens the Files picker). In Backups, folders from this iPhone replace the “open the desktop app” hint with Back up now, Pause, Show in Files, Archive / Restore folder and Stop backing up.


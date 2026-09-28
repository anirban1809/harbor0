# harbor0 interface refinement

The product is a private file workspace for people moving files between the cloud,
their computers, and other people. Its primary job is making file location and
transfer state easy to read. Preserve every existing data field, action, and theme.

## Design tokens

- Color: reuse the existing tokens without modifying them. The default light
  palette is canvas/card #ffffff, sidebar #fafafa, border #e6e6e5, accent #57534d,
  and text approximately #22211f. These are reference values only; the existing
  OKLCH definitions, dark themes, presets, and account overrides remain authoritative.
- Type: retain locally bundled Inter for controls and metadata, and Roboto for
  headings. Use 32/26 px page titles, 18 px section titles, 14 px primary rows,
  and 12–13 px secondary information. Use tabular numbers for storage and sizes.
- Space: 4, 8, 12, 16, 24, 32, 40 px. Controls use 36–40 px desktop targets;
  file filters expand to 40 px on narrow screens. Panels use 24 px inset; mobile uses 18 px.
- Shape: 8 px controls, 12 px panels, rounded status badges. Reserve elevation for
  menus, dialogs, and notifications; content is organized by spacing and borders.

## Layout exploration

Option A: a uniform stack of large panels is familiar, but creates unnecessarily
long settings pages and makes unrelated information look equally important.

    navigation | title + actions
               | large panel
               | large panel

Selected: a file-first workspace, with left-aligned titles and content, a consistent
navigation rail, and aligned file toolbars. Settings can use a narrower account
column beside appearance on wide screens, collapsing into reading order on mobile.

    navigation | search                         account
               | title                          actions
               | location / filters
               | names              metadata    actions

    settings   | appearance controls    | account details
               | preset themes          | profile fields
               | custom colors          | account actions

## Review against the brief

Do not introduce a dashboard hero, new accent, decorative artwork, new font, or
invented metrics. The distinctive element is the file list itself: a clean identity
column, readable metadata, and deliberate separation of cloud and synced files.
Use restrained headings and consistent control geometry everywhere else. Keep
all data visible, including on narrow screens through contained table scrolling.

Cover Drive, Favorites, Trash, Received, Sent, Shared, Devices, Storage, Settings,
Notifications, all authentication flows, desktop Backups, and Sync (including
activity, file browsing, and dialogs). Check both actual clients with isolated
fixtures, light/dark modes, keyboard use, reduced motion, and narrow viewports.

## Verification

- Web and Electron builds, TypeScript, and lint pass.
- Unit suite: 178 passing, 3 integration tests skipped.
- `scripts/transfer-layout-check.ts`: all 10 workspace pages on each client at
  1440, 1024, 768, and 390 px; transfer actions, pagination, and dark mode.
- `scripts/drive-redesign-check.ts`: populated cloud/synced sections, selection,
  filters, navigation, grid, file actions, and native dropped files.
- `scripts/sync-page-check.ts`: sync tabs, activity, folder browsing, recovery,
  confirmations, live progress, keyboard navigation, and dark mode.
- `scripts/web-styles-check.ts` against the local production server: CSS order,
  table/grid rendering, themes, route refreshes, and dialog focus.
- `scripts/ui-polish-check.ts`: all five account routes at 1440, 768, 390, and
  320 px; card control containment, long names, skip navigation, dialog focus
  restoration, reduced motion, and native desktop sign-in at 1440 and 840 px.
- `scripts/desktop-layout-check.ts`: all ten native workspace pages, populated
  backups, exact storage values, compact windows, and offline/error states.
  Updated stale checks to use the existing Storage page and Sync activity tab.

Screenshots are in `test-results/ui-polish`, `test-results/transfer-layout`,
`test-results/drive-redesign`, and `test-results/sync-page`. All checks use isolated
fixtures. No stored user data, theme definitions, or API behavior was changed.

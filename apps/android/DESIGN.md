# Android workspace

The Android app follows the web and desktop interface described in [docs/UI.md](../../docs/UI.md): the same tokens, type, icons and component shapes, laid out for a phone. Navigation, the document picker, file sharing and Back stay native.

Tokens mirror `apps/web/app/styles/tokens.css`. Five colors per mode can be customised (accent, background, cards, navigation, borders); text, fills, tints and status tones are derived in Oklab against whichever surface an element paints (`Theme.kt`, `SurfaceTokens`). The default Harbor theme is indigo `#4353d9` on white with a `#f4f5f7` navigation canvas; Ocean, Forest, Violet and Sunset match the web presets, each with a dark palette.

Type is Geist and Geist Mono, bundled as variable fonts in `res/font`. Sizes are in `sp` and follow system font scaling: 20 semibold page titles, 15 medium file names, 12–13 metadata. Icons are lucide, generated into `Icons.kt` by `generate-icons.mjs`.

Shell: the navigation color is the canvas and the working area sits on it as one bordered sheet with 16dp corners, as on the web. The five destinations are a bottom bar on the canvas; the active one is a raised pill in the page color with an accent icon. Sign-in reverses this: brand and tagline on the canvas, the form on the sheet.

    My Drive                        ⟳  [+]
    ─────────────────────────────────────
    My Drive › Documents
    [▢] Reports                       ›  ⋮
        Folder
    [▤] Welcome.txt                      ⋮
        46 B • Sep 30, 2026
    2 items
    ╰───────────────────────────────────╯
     Drive   Sync   Backups   Trash   Settings

Components live in `Kit.kt` and correspond to `apps/web/components/ui`: buttons (primary, outline, ghost, danger, link), bordered inputs with a focus ring and a label above, segmented control, badges, cards, alerts, progress, skeleton rows, menus, dialogs, empty states and the toast. Use them rather than Material components so heights, radii and borders stay consistent. Controls are 44dp (36dp small) with 48dp touch targets; radii are 6/8/12/16dp. Content is capped at 840dp on tablets.

States: skeleton rows on first load, the current list stays visible during background refreshes, failed loads show a retry state instead of an empty one, and confirmations use a danger button. Account storage and appearance live in Settings; appearance changes preview locally and are saved to the account explicitly.

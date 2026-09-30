# Android workspace

Carry the iOS workspace across faithfully: five permanent destinations, compact file rows, independent folder locations and explicit account theme saving. Native Android back navigation, document picker and file sharing replace the iOS equivalents.

Tokens: canvas #FAFAFA, surface #FFFFFF, ink/accent #171717, navigation #F5F5F5, border #E5E5E5. Copy Ocean, Forest, Violet and Sunset from iOS, including dark palettes and custom overrides. Derive readable foregrounds from each surface.

Type: Android's native sans family, 24sp semibold workspace titles, 16sp file names and 12sp metadata; respect system font scaling. Left aligned, centered content column capped at 840dp on tablets. Minimum 48dp touch targets.

    My Drive                     Refresh  +
    Cloud files
    ┌─────────────────────────────────────┐
    │ folder  Documents                 > │
    │ file    Welcome.txt               ⋮ │
    └─────────────────────────────────────┘
    Drive    Sync    Backups    Trash    Settings

The existing harbor0 wordmark and account palette provide identity. Keep the files central; no decorative statistics or new mobile branding. Account storage belongs in Settings. Read-only backups explain where automation runs. Loading, retry, empty, transfer and destructive confirmation states use concise action-oriented copy.

Review: this deliberately follows the supplied product design rather than inventing a new visual direction. Material components provide Android accessibility and navigation behavior while the account tokens determine their colors.

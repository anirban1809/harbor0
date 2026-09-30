# Mobile workspace and appearance

The iPhone app carries the existing web/desktop workspace into five bottom destinations: Drive, Sync, Backups, Trash, Settings. Keep folder navigation within each destination. Use compact file rows, fine dividers, rounded file-list surfaces and the same named account palettes; avoid adding dashboard statistics above the files.

Tokens: Harbor canvas #FAFAFA, surface #FFFFFF, ink #171717, secondary #737373, navigation #F5F5F5, divider #E5E5E5. Ocean uses accent #2563EB, canvas #EFF6FF, surface #FFFFFF, navigation #DBEAFE, divider #BFDBFE. Forest, Violet and Sunset copy the existing appearance-presets.ts values, with separate dark palettes. Honor saved custom accent/background/card/sidebar/border overrides and compute contrasting foreground colors.

Typography: native SF Pro, compact semibold navigation headings, regular 16–17 point file names, 12–13 point metadata. Use the plain harbor0 wordmark rather than the earlier rounded display treatment. Maintain Dynamic Type and 44-point minimum interaction areas.

Layout: left-aligned content in a single column, with a lightly outlined surface for related files/settings. A fixed bottom strip adopts the web sidebar palette; the active tab has an accent tint and explicit selected accessibility state.

```text
My Drive                       +
Cloud files
╭──────────────────────────────╮
│ folder  Documents          > │
│ file    Project brief.pdf  ↓ │
╰──────────────────────────────╯

Drive    Sync   Backups   Trash   Settings
```

Review: use the existing product palettes, not a new mobile-only accent. Keep native push navigation and previews, but use a fixed bottom strip to ensure these destinations remain at the bottom on both iPhone and iPad. Sync/Backups show real server data and clearly distinguish browsing from computer-managed automation. Settings previews changes immediately and explicitly saves them to the account, with retryable errors.

Visual QA: use inline native navigation titles. The iOS 26.5 simulator did not paint large titles reliably with themed navigation surfaces; compact titles also keep more room for files. Trash rows omit the download affordance because their actions are restore and delete.

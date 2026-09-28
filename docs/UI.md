# Shared interface

Web and Electron use the same shadcn/ui components in `apps/web/components/ui` and theme in `apps/web/app/globals.css`. The buttons, inputs, cards, and dialog primitives are adapted from the [official shadcn/ui registry](https://ui.shadcn.com/docs/components). `apps/web/components.json` configures future additions.

The supplied warm neutral light and dark palettes are preserved as semantic CSS variables. Tailwind v4 generates the component utilities; Next.js uses PostCSS, and Electron processes the same CSS through its build plugin. Inter and Roboto are bundled locally, including in the desktop build. The font mappings use the installed variable font names instead of self-referencing theme variables.

The appearance control follows the system preference until the user picks light or dark, then remembers the choice locally. Web and desktop keep independent preferences.

## UI verification

Build both clients and start the web client on port 3000, then run:

```sh
npm run test:ui
```

The check uses browser response fixtures and an isolated Electron profile. It covers authentication screens, populated file lists, web list/grid switching, menus, dialog focus and Escape dismissal, remembered web appearance, narrow web layout overflow, and desktop sync navigation. Screenshots are saved in `test-results/ui-redesign/`. It does not exercise live cloud uploads or transfers.

Run `npm run typecheck`, `npm run lint`, and `npm test` for the remaining local checks.

## Appearance settings

Open **Settings → Appearance** in either client. Choose Light, Dark, or System, then customize Accent, Background, Cards, Sidebar, and Borders using a picker or a three- or six-digit hex code. Each mode keeps its own palette. Colors apply immediately and save locally; the header theme toggle shares the same preference. Reset an individual color or all colors for the active theme to restore the supplied palette.

`apps/web/lib/appearance.ts` owns the shared appearance state and local persistence (`harbor-theme` and `harbor-colors`). Stored colors are validated before use. Companion foreground colors choose black or white for contrast, and the settings report when storage is unavailable. There is no account or cloud synchronization of appearance preferences.

`npm run test:ui` also checks custom colors, invalid input, reload persistence, light/dark isolation, system appearance, per-color and per-theme resets, and the mobile settings layout in browser/Electron fixtures. Color validation and contrast calculations have unit coverage.

## File browsing and loading

Both clients use `FileCollection` for a semantic table with name/type, size, modified and created timestamps, owner, and row actions. Trash uses the deletion date in place of the creation date. The web grid carries the same metadata. Compact layouts hide secondary columns; filenames retain full accessible labels and tooltips. The footer summarizes only the items currently shown, and folder sizes are left unknown instead of reporting zero. Desktop actions are available from each row’s menu, and large folders offer pagination.

Workspace, file list/grid, transfer, and other remote-content skeletons respect reduced-motion settings and announce loading to assistive technology. Initial desktop loads are separate from background refreshes. Failed file loads show retry controls, and request identity checks prevent stale folder responses from replacing the current view.

The UI fixture check covers delayed list responses, absence of premature empty states, table metadata, web selection, desktop pagination, retry, and out-of-order folder responses. Live cloud mutations are not part of these checks.

## Empty states

`EmptyState`, `FileEmptyState`, and `LoadError` provide shared illustrations, accessible headings, descriptions, and shadcn actions across both clients. My Drive and folders offer upload/create actions; search offers clearing; favorites, recent, trash, shares, and transfers explain their own content and link back to My Drive. Devices, notifications, version history, folder picking, and desktop backup/sync setup also have explicit empty states. Compact variants sit inside panels without a second border.

Failed requests show a retry state instead of an empty collection. The visuals use the active card palette, including custom colors, and wrap actions on narrow screens. Mobile summary cards prioritize labels and values to leave room for file content.

The fixture UI checks cover empty-view navigation and actions, the web upload picker, clear search, device refresh, desktop backup/sync setup, and light/dark/mobile screenshots without modifying live files.

The active master is `logo.svg`: a zero with a harbor entrance and one vessel inside.
`app-icon.png` and `app-icon-transparent.png` are the previous anchor-and-shield
artwork, kept for reference only; nothing reads them.

Run `npm run generate:icons` from the repository root to regenerate web favicons,
desktop and menu bar icons, mobile icons, and the social preview. The menu bar variant
uses the artwork's silhouette as a transparent template so macOS can render it in
either appearance. Generated PNGs preserve transparency, except the legacy iOS App
Store icon, whose asset-catalog format requires an opaque canvas. The iOS App Store
icon and the Android adaptive foreground get extra margin because launchers mask the
canvas. Android launchers may apply their own system icon treatment.

The in-app logo is drawn inline in `apps/web/components/brand-logo.tsx` and follows the
current text color for contrast in light and dark themes. Keep its geometry in sync
with `logo.svg`.

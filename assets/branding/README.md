The original supplied artwork is preserved in `app-icon.png`. The active master,
`app-icon-transparent.png`, contains only the logo with transparent negative space.

The transparent master was created with the built-in image editing tool using:
"Remove only the white background, including all enclosed white negative space,
and replace with genuine transparent alpha. Preserve the dark charcoal anchor,
shield and wave geometry. No redesign, added shapes, text, shadows or backdrop."

Run `npm run generate:icons` from the repository root to regenerate web favicons,
shared UI branding, desktop and menu bar icons, mobile icons, and the social preview.
The menu bar variant uses the artwork's silhouette as a transparent template so macOS
can render it in either appearance. In-app logos follow the current text color for
contrast in light and dark themes. Generated PNGs preserve transparency, except the
legacy iOS App Store icon, whose asset-catalog format requires an opaque canvas.
Android launchers may apply their own system icon treatment.

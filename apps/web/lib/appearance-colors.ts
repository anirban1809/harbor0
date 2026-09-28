export const colorFields = [
  { key: 'primary', label: 'Accent', description: 'Buttons, links, and focus rings' },
  { key: 'background', label: 'Background', description: 'Your main workspace' },
  { key: 'card', label: 'Cards', description: 'File lists, panels, and popovers' },
  { key: 'sidebar', label: 'Sidebar', description: 'Navigation and account area' },
  { key: 'border', label: 'Borders', description: 'Dividers and input outlines' },
] as const;
export type ColorKey = (typeof colorFields)[number]['key'];
export type Palette = Partial<Record<ColorKey, string>>;
export type Mode = 'light' | 'dark';
export type Palettes = Record<Mode, Palette>;

export function normalizeHex(value: string): string | null {
  const hex = value.trim();
  if (/^#[\da-f]{6}$/i.test(hex)) return hex.toLowerCase();
  if (/^#[\da-f]{3}$/i.test(hex))
    return (
      '#' +
      [...hex.slice(1)]
        .map((c) => c + c)
        .join('')
        .toLowerCase()
    );
  return null;
}
export function parsePalettes(raw: string | null): Palettes {
  const palettes: Palettes = { light: {}, dark: {} };
  try {
    const stored = JSON.parse(raw ?? '{}');
    for (const mode of ['light', 'dark'] as const) {
      for (const { key } of colorFields) {
        const value = stored?.[mode]?.[key];
        const color = typeof value === 'string' ? normalizeHex(value) : null;
        if (color) palettes[mode][key] = color;
      }
    }
  } catch {
    /* Invalid saved colors fall back to the supplied theme. */
  }
  return palettes;
}
export function contrastingText(hex: string): string {
  const rgb = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}
export function paletteTokens(palette: Palette): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(palette)) tokens[key] = value;
  if (palette.primary) {
    tokens['primary-foreground'] = contrastingText(palette.primary);
    tokens.ring = palette.primary;
    tokens['sidebar-primary'] = palette.primary;
    tokens['sidebar-primary-foreground'] = tokens['primary-foreground'];
    tokens['sidebar-ring'] = palette.primary;
  }
  if (palette.background) {
    const ink = contrastingText(palette.background);
    tokens.foreground = ink;
    tokens.muted = `color-mix(in srgb, ${palette.background}, ${ink} 6%)`;
    tokens['muted-foreground'] = `color-mix(in srgb, ${palette.background}, ${ink} 72%)`;
    tokens.secondary = tokens.muted;
    tokens['secondary-foreground'] = ink;
    tokens.accent = `color-mix(in srgb, ${palette.background}, ${ink} 12%)`;
    tokens['accent-foreground'] = ink;
  }
  if (palette.card) {
    tokens['card-foreground'] = contrastingText(palette.card);
    tokens.popover = palette.card;
    tokens['popover-foreground'] = tokens['card-foreground'];
  }
  if (palette.sidebar) {
    tokens['sidebar-foreground'] = contrastingText(palette.sidebar);
    tokens['sidebar-accent'] =
      `color-mix(in srgb, ${palette.sidebar}, ${tokens['sidebar-foreground']} 10%)`;
    tokens['sidebar-accent-foreground'] = tokens['sidebar-foreground'];
  }
  if (palette.border) {
    tokens.input = palette.border;
    tokens['sidebar-border'] = palette.border;
  }
  return tokens;
}

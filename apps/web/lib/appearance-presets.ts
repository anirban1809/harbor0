import type { ThemePreset } from '@harbor/contracts';
import type { Palettes } from './appearance-colors';

export const appearancePresets: {
  id: ThemePreset;
  name: string;
  description: string;
  palettes: Palettes;
  swatches: string[];
}[] = [
  {
    id: 'default',
    name: 'Harbor',
    description: 'Neutral grays',
    palettes: { light: {}, dark: {} },
    swatches: ['#fafafa', '#ffffff', '#171717'],
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Blue tones',
    swatches: ['#eff6ff', '#dbeafe', '#2563eb'],
    palettes: {
      light: {
        primary: '#2563eb',
        background: '#eff6ff',
        card: '#ffffff',
        sidebar: '#dbeafe',
        border: '#bfdbfe',
      },
      dark: {
        primary: '#60a5fa',
        background: '#0b1220',
        card: '#111e33',
        sidebar: '#0e192b',
        border: '#294362',
      },
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Green tones',
    swatches: ['#f0f7f2', '#deeee2', '#187047'],
    palettes: {
      light: {
        primary: '#187047',
        background: '#f0f7f2',
        card: '#ffffff',
        sidebar: '#deeee2',
        border: '#bed8c6',
      },
      dark: {
        primary: '#6cce98',
        background: '#0c1712',
        card: '#14261d',
        sidebar: '#102017',
        border: '#305340',
      },
    },
  },
  {
    id: 'violet',
    name: 'Violet',
    description: 'Purple tones',
    swatches: ['#f7f3ff', '#ede5fb', '#7c3aed'],
    palettes: {
      light: {
        primary: '#7c3aed',
        background: '#f7f3ff',
        card: '#ffffff',
        sidebar: '#ede5fb',
        border: '#d8c9ed',
      },
      dark: {
        primary: '#b794f6',
        background: '#171122',
        card: '#241b34',
        sidebar: '#1d162b',
        border: '#4a3766',
      },
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Orange tones',
    swatches: ['#fff7ed', '#ffead5', '#b94719'],
    palettes: {
      light: {
        primary: '#b94719',
        background: '#fff7ed',
        card: '#fffcf8',
        sidebar: '#ffead5',
        border: '#edcdb2',
      },
      dark: {
        primary: '#fbad77',
        background: '#20140f',
        card: '#302018',
        sidebar: '#281a13',
        border: '#60412f',
      },
    },
  },
];

export function presetPalettes(id: ThemePreset): Palettes {
  return appearancePresets.find((preset) => preset.id === id)!.palettes;
}

'use client';
import { Moon, Sun } from 'lucide-react';
import { Button } from './ui/button';
import { setAppearanceMode, useAppearance } from '../lib/appearance';

export function ThemeToggle() {
  const { mode, ready } = useAppearance();
  const dark = mode === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={!ready}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => setAppearanceMode(dark ? 'light' : 'dark')}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

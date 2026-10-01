'use client';
import { Moon, Sun } from 'lucide-react';

/** Flips the `dark` class set by the layout's theme script and remembers the choice. */
export function ThemeToggle() {
  return (
    <button
      type="button"
      className="btn theme-toggle"
      data-variant="ghost"
      data-size="icon"
      aria-label="Switch between light and dark theme"
      title="Switch between light and dark theme"
      onClick={() => {
        const dark = document.documentElement.classList.toggle('dark');
        try {
          localStorage.setItem('harbor-landing-theme', dark ? 'dark' : 'light');
        } catch {
          // Private browsing: the choice lasts for this page view only.
        }
      }}
    >
      <Moon className="theme-toggle-moon" />
      <Sun className="theme-toggle-sun" />
    </button>
  );
}

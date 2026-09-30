'use client';
import { useEffect, useId, useState } from 'react';
import { Monitor, Moon, RotateCcw, Sun } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Segmented } from './ui/segmented';
import { colorFields, normalizeHex } from '../lib/appearance-colors';
import { appearancePresets } from '../lib/appearance-presets';
import {
  effectiveHex,
  resetAppearanceColors,
  setAppearanceColor,
  setAppearanceMode,
  setAppearancePreset,
  retryAppearance,
  useAppearance,
} from '../lib/appearance';

function ColorControl({ field }: { field: (typeof colorFields)[number] }) {
  const appearance = useAppearance();
  const custom = appearance.palettes[appearance.mode][field.key];
  const [value, setValue] = useState('#000000');
  const [error, setError] = useState(false);
  const id = useId();
  useEffect(() => {
    setValue(custom ?? effectiveHex(field.key));
    setError(false);
  }, [appearance.mode, appearance.preset, appearance.palettes, custom, field.key]);
  function commit(value: string) {
    const color = normalizeHex(value);
    if (!color) {
      setError(true);
      return;
    }
    setError(false);
    setValue(color);
    setAppearanceColor(field.key, color);
  }
  return (
    <div className="appearance-color-row">
      <div>
        <label htmlFor={id}>{field.label}</label>
        <p className="muted">{field.description}</p>
      </div>
      <div className="appearance-color-controls">
        <input
          type="color"
          aria-label={`${field.label} color picker`}
          value={normalizeHex(value) ?? custom ?? '#000000'}
          onChange={(event) => commit(event.target.value)}
        />
        <Input
          id={id}
          className="appearance-hex"
          aria-label={`${field.label} hex color`}
          aria-invalid={error}
          aria-describedby={error ? `${id}-error` : undefined}
          value={value}
          spellCheck={false}
          maxLength={7}
          onChange={(event) => {
            setValue(event.target.value);
            setError(false);
            if (/^#[\da-f]{6}$/i.test(event.target.value)) commit(event.target.value);
          }}
          onBlur={() => commit(value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(value);
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          disabled={!custom}
          aria-label={`Reset ${field.label.toLowerCase()} color`}
          title={`Reset ${field.label.toLowerCase()} color`}
          onClick={() => setAppearanceColor(field.key, null)}
        >
          <RotateCcw />
        </Button>
        {error && (
          <p id={`${id}-error`} role="alert" className="appearance-color-error">
            Use a hex color, like #2563eb or #fff.
          </p>
        )}
      </div>
    </div>
  );
}
export function AppearanceSettings() {
  const { preference, preset, mode, palettes, status, ready } = useAppearance();
  const modified = Object.keys(palettes[mode]).length > 0;
  return (
    <Card
      className="appearance-settings"
      title="Appearance"
      description="Theme settings apply across your devices."
    >
      <fieldset className="appearance-controls" disabled={!ready}>
        <fieldset className="appearance-section">
          <legend>Color mode</legend>
          <Segmented
            label="Color mode"
            className="appearance-mode-options"
            value={preference}
            onValueChange={setAppearanceMode}
            options={[
              { value: 'light', label: 'Light', icon: <Sun /> },
              { value: 'dark', label: 'Dark', icon: <Moon /> },
              { value: 'system', label: 'System', icon: <Monitor /> },
            ]}
          />
        </fieldset>
        <fieldset className="appearance-section">
          <legend>Preset themes</legend>
          <p className="muted appearance-help">
            Each theme includes light and dark colors. Choosing a preset resets custom colors.
          </p>
          <div className="appearance-preset-grid">
            {appearancePresets.map((theme) => (
              <button
                type="button"
                key={theme.id}
                className="appearance-preset"
                aria-pressed={preset === theme.id}
                onClick={() => setAppearancePreset(theme.id)}
              >
                <span className="appearance-swatches" aria-hidden="true">
                  {(theme.id === 'default'
                    ? theme.swatches
                    : Object.values(theme.palettes[mode]).slice(0, 3)
                  ).map((color, index) => (
                    <span key={index} style={{ backgroundColor: color }} />
                  ))}
                </span>
                <strong>{theme.name}</strong>
                <span className="muted">{theme.description}</span>
                {preset === theme.id && (
                  <span className="appearance-preset-selected">
                    {Object.keys(palettes.light).length || Object.keys(palettes.dark).length
                      ? 'Customized'
                      : 'Selected'}
                  </span>
                )}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="appearance-section">
          <div className="appearance-colors-heading">
            <h3>Custom colors</h3>
            <Badge>{mode === 'light' ? 'Light theme' : 'Dark theme'}</Badge>
          </div>
          <p className="muted appearance-help">
            Choose a color or enter a hex code. Light and dark themes keep separate colors.
          </p>
          {colorFields.map((field) => (
            <ColorControl key={field.key} field={field} />
          ))}
        </div>
      </fieldset>
      <div className="appearance-footer">
        <p role="status" className="muted">
          {status === 'loading'
            ? 'Loading your account theme…'
            : status === 'saving'
              ? 'Saving to your account…'
              : status === 'saved'
                ? 'Saved to your account.'
                : status === 'error'
                  ? ready
                    ? 'Applied here. Couldn’t save to your account. Please retry.'
                    : 'Couldn’t load your account theme. Please retry.'
                  : 'Sign in to save your theme to your account.'}
        </p>
        {status === 'error' && (
          <Button variant="outline" onClick={retryAppearance}>
            Retry
          </Button>
        )}
        <Button variant="outline" disabled={!ready || !modified} onClick={resetAppearanceColors}>
          <RotateCcw />
          Reset {mode} colors
        </Button>
      </div>
    </Card>
  );
}

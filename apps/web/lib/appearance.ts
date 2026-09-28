'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { appearanceSchema, type AppearancePreference, type ThemePreset } from '@harbor/contracts';
import type { Transport } from '@harbor/api-client';
import {
  normalizeHex,
  paletteTokens,
  parsePalettes,
  type ColorKey,
  type Mode,
} from './appearance-colors';
import { presetPalettes } from './appearance-presets';

type SaveStatus = 'device' | 'loading' | 'saving' | 'saved' | 'error';
type Appearance = AppearancePreference & { mode: Mode; status: SaveStatus; ready: boolean };
const defaults: AppearancePreference = {
  preference: 'system',
  preset: 'default',
  palettes: { light: {}, dark: {} },
};
const initial: Appearance = { ...defaults, mode: 'light', status: 'device', ready: true };
let state = initial;
const listeners = new Set<() => void>();
let appliedTokens: string[] = [];
const mediaQuery = '(prefers-color-scheme: dark)';
type Connection = {
  request: Transport;
  controller: AbortController;
  revision: number;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
let account: Connection | undefined;
export function effectivePalette() {
  return { ...presetPalettes(state.preset)[state.mode], ...state.palettes[state.mode] };
}
function apply() {
  const root = document.documentElement;
  root.classList.toggle('dark', state.mode === 'dark');
  const palette = effectivePalette();
  root.toggleAttribute('data-custom-colors', Object.keys(palette).length > 0);
  for (const token of appliedTokens) root.style.removeProperty('--' + token);
  const tokens = paletteTokens(palette);
  appliedTokens = Object.keys(tokens);
  for (const [token, value] of Object.entries(tokens)) root.style.setProperty('--' + token, value);
  listeners.forEach((listener) => listener());
}
function resolved(preference: AppearancePreference['preference']): Mode {
  return preference === 'system'
    ? window.matchMedia(mediaQuery).matches
      ? 'dark'
      : 'light'
    : preference;
}
function loadDevice() {
  if (account) return;
  let preference: AppearancePreference = defaults;
  try {
    const saved = localStorage.getItem('harbor-appearance');
    const parsed = appearanceSchema.safeParse(saved ? JSON.parse(saved) : undefined);
    const legacy = localStorage.getItem('harbor-theme');
    preference = parsed.success
      ? parsed.data
      : {
          ...defaults,
          preference: legacy === 'light' || legacy === 'dark' ? legacy : 'system',
          palettes: parsePalettes(localStorage.getItem('harbor-colors')),
        };
  } catch {
    /* Device storage is optional; account settings do not depend on it. */
  }
  state = { ...preference, mode: resolved(preference.preference), status: 'device', ready: true };
  apply();
}
function systemChanged() {
  state = { ...state, mode: resolved(state.preference) };
  apply();
}
function storageChanged(event: StorageEvent) {
  if (
    event.key === null ||
    ['harbor-theme', 'harbor-colors', 'harbor-appearance'].includes(event.key)
  )
    loadDevice();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    loadDevice();
    window.matchMedia(mediaQuery).addEventListener('change', systemChanged);
    window.addEventListener('storage', storageChanged);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.matchMedia(mediaQuery).removeEventListener('change', systemChanged);
      window.removeEventListener('storage', storageChanged);
    }
  };
}
function preferenceSnapshot(): AppearancePreference {
  return { preference: state.preference, preset: state.preset, palettes: state.palettes };
}
async function loadAccount(connection: Connection) {
  if (account !== connection || connection.loading || connection.dirty || connection.saving) return;
  connection.loading = true;
  const revision = connection.revision;
  try {
    const { user } = await connection.request('/v1/users/me', {
      signal: connection.controller.signal,
    });
    const preference =
      user.appearance === undefined ? defaults : appearanceSchema.parse(user.appearance);
    if (account !== connection || revision !== connection.revision) return;
    state = { ...preference, mode: resolved(preference.preference), status: 'saved', ready: true };
    apply();
  } catch {
    if (account === connection && revision === connection.revision) {
      state = { ...state, status: 'error' };
      apply();
    }
  } finally {
    connection.loading = false;
  }
}
async function saveAccount(connection: Connection) {
  if (account !== connection || connection.saving || !connection.dirty) return;
  connection.saving = true;
  const revision = connection.revision;
  let succeeded = false;
  state = { ...state, status: 'saving' };
  apply();
  try {
    await connection.request('/v1/users/me', {
      method: 'PATCH',
      body: { operationId: crypto.randomUUID(), appearance: preferenceSnapshot() },
      signal: connection.controller.signal,
    });
    succeeded = true;
    if (account !== connection) return;
    if (revision === connection.revision) connection.dirty = false;
    state = { ...state, status: connection.dirty ? 'saving' : 'saved' };
    apply();
  } catch {
    if (account === connection) {
      state = { ...state, status: 'error' };
      apply();
    }
  } finally {
    connection.saving = false;
    // Serialize writes so a slow older response cannot replace a newer selection.
    if (
      account === connection &&
      connection.dirty &&
      (succeeded || revision !== connection.revision)
    )
      void saveAccount(connection);
  }
}
export function retryAppearance() {
  if (!account) return;
  if (account.dirty) void saveAccount(account);
  else void loadAccount(account);
}
/** Each sign-in gets an isolated connection; late responses cannot affect the next account. */
export function connectAccountAppearance(request: Transport) {
  const connection: Connection = {
    request,
    controller: new AbortController(),
    revision: 0,
    dirty: false,
    loading: false,
    saving: false,
  };
  account = connection;
  state = { ...defaults, mode: resolved(defaults.preference), ready: false, status: 'loading' };
  apply();
  void loadAccount(connection);
  const refresh = () => {
    if (account === connection) retryAppearance();
  };
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
  return () => {
    connection.controller.abort();
    window.clearTimeout(connection.timer);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('online', refresh);
    if (account === connection) {
      account = undefined;
      loadDevice();
    }
  };
}
export function useAccountAppearance(accountKey: string | undefined, request: Transport) {
  useEffect(() => {
    if (accountKey) return connectAccountAppearance(request);
  }, [accountKey, request]);
}
function save() {
  if (account) {
    account.revision++;
    account.dirty = true;
    state = { ...state, status: 'saving' };
    window.clearTimeout(account.timer);
    const connection = account;
    connection.timer = setTimeout(() => void saveAccount(connection), 300);
  } else {
    try {
      localStorage.setItem('harbor-appearance', JSON.stringify(preferenceSnapshot()));
    } catch {
      /* Applies for this session. */
    }
  }
  apply();
}
export function setAppearanceMode(preference: AppearancePreference['preference']) {
  if (!state.ready) return;
  state = { ...state, preference, mode: resolved(preference) };
  save();
}
export function setAppearancePreset(preset: ThemePreset) {
  if (!state.ready) return;
  state = { ...state, preset, palettes: { light: {}, dark: {} } };
  save();
}
export function setAppearanceColor(key: ColorKey, value: string | null) {
  if (!state.ready) return;
  const color = value === null ? null : normalizeHex(value);
  if (value !== null && !color) return;
  const palette = { ...state.palettes[state.mode] };
  if (color) palette[key] = color;
  else delete palette[key];
  state = { ...state, palettes: { ...state.palettes, [state.mode]: palette } };
  save();
}
export function resetAppearanceColors() {
  if (!state.ready) return;
  state = { ...state, palettes: { ...state.palettes, [state.mode]: {} } };
  save();
}
export function useAppearance() {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => initial,
  );
}

/** Convert the effective theme color to the sRGB hex format used by native color inputs. */
export function effectiveHex(token: ColorKey): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) return '#000000';
  context.fillStyle = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue('--' + token)
    .trim();
  context.fillRect(0, 0, 1, 1);
  return (
    '#' +
    [...context.getImageData(0, 0, 1, 1).data]
      .slice(0, 3)
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  );
}

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

const desktopKeys = ['HARBOR_DEV_AUTH', 'HARBOR_API_URL', 'HARBOR_WEB_URL'] as const;

/** Only desktop settings are loaded; shell values win over .env.local and .env. */
export function loadDesktopEnvironment(directory: string, env: NodeJS.ProcessEnv) {
  const values: Record<string, string> = {};
  for (const file of ['.env', '.env.local']) {
    try {
      const parsed = parseEnv(readFileSync(path.join(directory, file), 'utf8'));
      for (const key of desktopKeys) if (parsed[key] !== undefined) values[key] = parsed[key];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const key of desktopKeys)
    if (env[key] === undefined && values[key] !== undefined) env[key] = values[key];
}

/** Release bundles contain only the public API connection value. Shell overrides remain supported. */
export function loadBundledDesktopConfiguration(directory: string, env: NodeJS.ProcessEnv) {
  try {
    const values = JSON.parse(readFileSync(path.join(directory, 'desktop-config.json'), 'utf8'));
    for (const key of desktopKeys) {
      if (key !== 'HARBOR_DEV_AUTH' && env[key] === undefined && typeof values[key] === 'string')
        env[key] = values[key];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function desktopConfiguration(env: NodeJS.ProcessEnv, packaged: boolean) {
  const development = !packaged && env.HARBOR_DEV_AUTH === 'true';
  const apiUrl = (env.HARBOR_API_URL ?? (development ? 'http://127.0.0.1:8787' : ''))
    .trim()
    .replace(/\/$/, '');
  function validUrl(value: string, allowLocal = false) {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' ||
          (allowLocal && url.protocol === 'http:' && url.hostname === '127.0.0.1'))
      );
    } catch {
      return false;
    }
  }
  // Optional: the web app that hosts account creation and password reset.
  const webUrl = (env.HARBOR_WEB_URL ?? (development ? 'http://127.0.0.1:3000' : ''))
    .trim()
    .replace(/\/$/, '');
  const errors: string[] = [];
  if (!validUrl(apiUrl, development))
    errors.push('Set HARBOR_API_URL to your HTTPS harbor0 server.');
  return {
    development,
    apiUrl,
    webUrl: validUrl(webUrl, development) ? webUrl : '',
    configured: errors.length === 0,
    configurationError: errors.join(' '),
  };
}

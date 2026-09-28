import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  desktopConfiguration,
  loadDesktopEnvironment,
  loadBundledDesktopConfiguration,
} from '../src/config';

describe('desktop connection settings', () => {
  it('loads only desktop settings with local-file and shell precedence', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harbor-config-'));
    try {
      writeFileSync(
        path.join(dir, '.env'),
        'HARBOR_API_URL=https://base.example\nHARBOR_COGNITO_DOMAIN=https://login.example\nAWS_SECRET_ACCESS_KEY=do-not-load\n',
      );
      writeFileSync(
        path.join(dir, '.env.local'),
        'HARBOR_API_URL="https://local.example"\nHARBOR_DEV_AUTH=true\nHARBOR_COGNITO_CLIENT_ID=file-client\n',
      );
      const env: NodeJS.ProcessEnv = { HARBOR_DEV_AUTH: 'false' };
      loadDesktopEnvironment(dir, env);
      expect(env).toEqual({
        HARBOR_API_URL: 'https://local.example',
        HARBOR_DEV_AUTH: 'false',
      });
      expect(desktopConfiguration(env, false).configured).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('requires only an HTTPS API URL for production sign-in', () => {
    expect(desktopConfiguration({}, false).configured).toBe(false);
    for (const packaged of [false, true])
      expect(
        desktopConfiguration({ HARBOR_API_URL: 'https://api.example' }, packaged).configured,
      ).toBe(true);
    const config = desktopConfiguration(
      {
        HARBOR_API_URL: 'https://api.example/',
        HARBOR_COGNITO_DOMAIN: 'https://login.example/',
        HARBOR_COGNITO_CLIENT_ID: 'client',
      },
      false,
    );
    expect(config.configured).toBe(true);
    expect(config.apiUrl).toBe('https://api.example');
  });
  it('keeps development authentication explicit and unavailable in packaged apps', () => {
    expect(desktopConfiguration({ HARBOR_DEV_AUTH: 'true' }, false).configured).toBe(true);
    expect(desktopConfiguration({ HARBOR_DEV_AUTH: 'true' }, true).configured).toBe(false);
    expect(
      desktopConfiguration(
        { HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: 'http://remote.example' },
        false,
      ).configured,
    ).toBe(false);
    expect(
      desktopConfiguration(
        {
          HARBOR_API_URL: 'http://127.0.0.1:8787',
          HARBOR_COGNITO_DOMAIN: 'https://login.example',
          HARBOR_COGNITO_CLIENT_ID: 'client',
        },
        false,
      ).configured,
    ).toBe(false);
  });
});

it('loads only public release settings and cannot enable development auth from the bundle', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'harbor-release-config-'));
  try {
    writeFileSync(
      path.join(directory, 'desktop-config.json'),
      JSON.stringify({
        HARBOR_API_URL: 'https://api.example',
        HARBOR_COGNITO_DOMAIN: 'https://login.example',
        HARBOR_COGNITO_CLIENT_ID: 'bundle-client',
        HARBOR_DEV_AUTH: 'true',
        AWS_SECRET_ACCESS_KEY: 'must-not-load',
      }),
    );
    const env: NodeJS.ProcessEnv = { HARBOR_API_URL: 'https://shell.example' };
    loadBundledDesktopConfiguration(directory, env);
    expect(env).toEqual({
      HARBOR_API_URL: 'https://shell.example',
    });
    expect(desktopConfiguration(env, true)).toMatchObject({ configured: true, development: false });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

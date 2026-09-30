import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'harbor-share-ui-'));
const output = path.resolve('test-results/shared-sync');
await mkdir(output, { recursive: true });
await build({
  stdin: {
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SyncPage } from './apps/desktop/src/sync-page';
import { SyncNotifications } from './apps/desktop/src/sync-notifications';
import { useActivityFeed } from './apps/web/components/activity-notifications';
function App() {
 const [roots, setRoots] = useState(window.fixtureRoots);
 const feed = useActivityFeed('fixture');
 const state = {running:false,paused:false,online:true,message:'Ready',queued:0,lastSync:null,active:null,issues:[],recent:[]};
 const refresh = async()=>setRoots([...window.fixtureRoots]);
 return <main className="app-shell" style={{padding:24}}><SyncNotifications feed={feed} roots={roots} jobs={[]} state={state} refresh={refresh} showBanner manageFolders={()=>{}} manageStorage={()=>{}}/><SyncPage roots={roots} jobs={[]} state={{running:false,paused:false,online:true,message:'Ready',queued:0,lastSync:null,active:null,issues:[],recent:[]}} deviceName="My computer" refresh={async()=>setRoots([...window.fixtureRoots])} openCloud={()=>{}} /></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  outfile: path.join(temporary, 'app.js'),
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await writeFile(
  path.join(temporary, 'index.html'),
  `<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${pathToFileURL(path.resolve('apps/desktop/dist/renderer/app.css'))}"><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="app.js"></script></body></html>`,
);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any;
    w.__name = (fn: unknown) => fn;
    w.calls = [];
    w.fixtureRoots = [
      {
        id: 'local',
        remoteId: 'owned-folder',
        localPath: '/Users/alice/Project',
        localPathDisplayName: 'Project',
        mode: 'sync',
        paused: false,
        excluded: [],
        fileCount: 3,
        folderCount: 0,
      },
    ];
    w.invitations = [
      {
        id: 'received-share',
        driveItemId: 'received-folder',
        name: 'Team documents',
        direction: 'RECEIVED',
        ownerUserId: 'bob',
        recipientUserId: 'alice',
        permission: 'EDITOR',
        syncState: 'PENDING',
        createdAt: new Date().toISOString(),
        revokedAt: null,
        owner: { username: 'bob', displayName: 'Bob Chen' },
        recipient: { username: 'alice', displayName: 'Alice Morgan' },
      },
    ];
    w.harbor = {
      request: async (input: any) => {
        w.calls.push(input);
        if (input.path === '/v1/sync/shares' && (!input.method || input.method === 'GET'))
          return { items: structuredClone(w.invitations) };
        if (input.path === '/v1/sync/shares' && input.method === 'POST') {
          const share = {
            ...w.invitations[0],
            id: 'sent-share',
            name: 'Project',
            driveItemId: 'owned-folder',
            direction: 'SENT',
            owner: { username: 'alice', displayName: 'Alice Morgan' },
            recipient: { username: 'carol', displayName: 'Carol Lee' },
          };
          w.invitations.push(share);
          return { share };
        }
        if (input.path.endsWith('/respond')) {
          if (w.failRespond) throw new Error('Could not respond to this invitation. Try again.');
          w.invitations[0].syncState = input.body.action;
          return { share: w.invitations[0] };
        }
        if (input.method === 'DELETE') {
          w.invitations = w.invitations.filter((i: any) => input.path !== `/v1/shares/${i.id}`);
          return {};
        }
        return { items: [], nextCursor: null };
      },
      selectSyncLocal: async () => ({
        selectionId: 'selected',
        path: '/Users/alice/Team documents',
        name: 'Team documents',
      }),
      addSyncRoot: async (input: any) => {
        w.calls.push({ addSyncRoot: input });
        w.fixtureRoots.push({
          id: 'shared-local',
          remoteId: input.cloudFolderId,
          shareId: input.shareId,
          localPath: '/Users/alice/Team documents',
          localPathDisplayName: 'Team documents',
          mode: 'sync',
          paused: false,
          excluded: [],
          fileCount: 0,
          folderCount: 0,
        });
      },
      stopSyncRoot: async (input: any) => {
        w.fixtureRoots = w.fixtureRoots.filter((r: any) => r.id !== input.id);
      },
    };
  });
  await page.goto(pathToFileURL(path.join(temporary, 'index.html')).href);
  if (errors.length) throw new Error(JSON.stringify(errors));
  await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'invitations.png') });
  await page.getByRole('button', { name: 'Manage Project', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Share folder', exact: true }).click();
  await page.getByLabel('Email or username').fill('carol');
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Carol Lee');
  await page.screenshot({ path: path.join(output, 'owner-sharing.png') });
  await page.getByRole('button', { name: 'Remove access', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirm removal' })).toContainText(
    'Files already downloaded will remain',
  );
  await page
    .getByRole('group', { name: 'Confirm removal' })
    .getByRole('button', { name: 'Remove access', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('No invitations yet.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: /Activity notifications/ }).click();
  await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Accept and start syncing', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Choose local folder', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'recipient-acceptance.png') });
  await page.getByRole('button', { name: 'Accept and start syncing', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Manage Team documents', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Manage Team documents', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Share folder', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(output, 'shared-folder.png') });
  const calls = await page.evaluate(() => (window as any).calls);
  expect(calls).toContainEqual({
    addSyncRoot: {
      selectionId: 'selected',
      cloudFolderId: 'received-folder',
      shareId: 'received-share',
    },
  });
  // Dismissal keeps the invitation actionable; failed responses keep it visible for retry.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss sync banner' }).click();
  await expect(page.getByRole('region', { name: 'Sync action required' })).toHaveCount(0);
  await page.getByRole('button', { name: /Activity notifications/ }).click();
  await page.evaluate(() => {
    (window as any).failRespond = true;
  });
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not respond');
  await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).failRespond = false;
  });
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    'Shared sync UI: invite, remove access, choose local folder, accept, and recipient restrictions passed.',
  );
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}

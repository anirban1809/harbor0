import React from 'react';
import { writeFile } from 'node:fs/promises';
import { ImageResponse } from 'next/og';
import { brandMarkPath, brandName } from '../apps/web/lib/brand';

const alt = 'harbor0 — File storage, backup, sync, and sharing. 100 GB free.';
const size = { width: 1200, height: 630 };

function Image() {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        padding: 80,
        background: '#fafafa',
        color: '#171717',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 56 }}>
        <svg width="64" height="64" viewBox="0 0 40 40" fill="none">
          <path
            d={brandMarkPath}
            stroke="#57534d"
            strokeWidth="2.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {brandName}
      </div>
      <div style={{ display: 'flex', marginTop: 90, fontSize: 64 }}>File storage and sync</div>
      <div style={{ display: 'flex', marginTop: 24, fontSize: 30, color: '#57534d' }}>
        Store, back up, sync, and share files.
      </div>
      <div style={{ display: 'flex', marginTop: 'auto', fontSize: 26, color: '#57534d' }}>
        100 GB free
      </div>
    </div>,
    size,
  );
}

await writeFile('apps/web/app/opengraph-image.png', Buffer.from(await Image().arrayBuffer()));
await writeFile('apps/web/app/opengraph-image.alt.txt', alt + '\n');

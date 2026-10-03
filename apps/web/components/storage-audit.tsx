'use client';
import { useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import type { ApiClient } from '@harbor/api-client';
import { downloadStorageAudit } from '../lib/storage-audit';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Card } from './ui/card';

/** Downloads a CSV of every stored file version behind the account's storage total. */
export function StorageAudit({ api }: { api: ApiClient }) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; count: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const run = async () => {
    setState({ kind: 'running' });
    try {
      setState({ kind: 'done', count: await downloadStorageAudit(api) });
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message });
    }
  };
  return (
    <Card
      className="panel"
      title="Storage audit"
      description="Download a spreadsheet of every file version counted toward your storage — My Drive, backups and synced folders from all your devices, trash, and version history."
      action={
        <Button variant="outline" onClick={() => void run()} disabled={state.kind === 'running'}>
          <FileSpreadsheet aria-hidden="true" />
          {state.kind === 'running' ? 'Preparing audit…' : 'Download audit (CSV)'}
        </Button>
      }
    >
      {state.kind === 'done' && (
        <Alert tone="success">
          Downloaded an audit of {state.count.toLocaleString()} file{' '}
          {state.count === 1 ? 'version' : 'versions'}.
        </Alert>
      )}
      {state.kind === 'error' && <Alert tone="error">{state.message}</Alert>}
    </Card>
  );
}

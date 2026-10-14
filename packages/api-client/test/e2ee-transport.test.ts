import { expect, it } from 'vitest';
import { isEncryptedName } from '@harbor/contracts';
import { e2eeTransport } from '../src/e2ee-transport';
import { accountKeys, decryptName, newMasterKey } from '../src/e2ee';

it('encrypts the name of each encrypted file in a synced folder’s upload batch', async () => {
  const keys = await accountKeys(newMasterKey());
  const sent: { uploads: { name: string }[] }[] = [];
  const transport = e2eeTransport(
    async (_path, init) => {
      sent.push(init?.body as (typeof sent)[number]);
      return { results: [] };
    },
    { vault: () => ({ userId: 'alice', enabled: true, keys }), onAccount: () => {} },
  );
  await transport('/v1/uploads/batch', {
    method: 'POST',
    body: {
      uploads: [
        { name: 'Taxes 2025.pdf', encrypted: true, sizeBytes: 100 },
        { name: 'plain.txt', sizeBytes: 5 },
      ],
    },
  });
  const [secret, plain] = sent[0].uploads;
  expect(isEncryptedName(secret.name)).toBe(true);
  expect(await decryptName(keys, secret.name)).toBe('Taxes 2025.pdf');
  expect(plain.name).toBe('plain.txt');
});

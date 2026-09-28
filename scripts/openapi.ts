import { writeFile } from 'node:fs/promises';
import { createApp } from '../apps/backend/src/api';
import { DevelopmentAuth } from '../apps/backend/src/auth';
import { MemoryRepository } from '../apps/backend/src/repository';
import { MemoryStorage } from '../apps/backend/src/storage';
import { StorageService } from '../apps/backend/src/domain';
import openapiTS, { astToString } from 'openapi-typescript';
const { document } = createApp(
  new StorageService(new MemoryRepository(), new MemoryStorage()),
  new DevelopmentAuth(),
);
const schema = document();
await writeFile('docs/openapi.json', JSON.stringify(schema, null, 2) + '\n');
const types = await openapiTS(schema as Parameters<typeof openapiTS>[0]);
await writeFile('packages/api-client/src/generated.ts', astToString(types));

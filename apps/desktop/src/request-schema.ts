import { z } from 'zod';

const existingRoutes =
  /^\/v1\/(users|drive|uploads|downloads|transfers|shares|search|devices|notifications|billing|backups)(\/|\?|$)/;
const syncShareRoute = /^\/v1\/sync\/shares(?:\/[^/?]+\/(?:respond|status))?(?:\?.*)?$/;
const syncFolderRoute = /^\/v1\/sync\/(folders|status)(?:\?.*)?$/;

export const rendererRequestSchema = z
  .object({
    path: z
      .string()
      .max(4096)
      .refine(
        (path) =>
          (existingRoutes.test(path) || syncFolderRoute.test(path) || syncShareRoute.test(path)) &&
          !path.includes('..') &&
          !path.includes('\\') &&
          !path.includes('#'),
        'Invalid API path.',
      ),
    method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).default('GET'),
    body: z.unknown().optional(),
  })
  .strict()
  .refine(
    (input) => !syncFolderRoute.test(input.path) || input.method === 'GET',
    'Synced folders can only be read from the file browser.',
  );

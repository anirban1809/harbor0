import { z } from 'zod';

/**
 * Features still being rolled out. Each one is off for everyone until staff turn it on in the
 * console, for chosen accounts, a share of everyone, or all accounts. Add a flag here before
 * building behind it; remove it once the feature is on for everyone and its checks are gone.
 */
export const featureFlags = {
  'two-factor': {
    description:
      'Two-step verification: turn on an authenticator app or email codes in Settings. Sign-in asks accounts that have it on for their code whether or not the flag is on.',
  },
} as const satisfies Record<string, { description: string }>;
export type FlagKey = keyof typeof featureFlags;
/** Every defined flag; read when needed, so tests can define their own. */
export const flagKeys = () => Object.keys(featureFlags) as FlagKey[];
export const flagDescription = (key: FlagKey) =>
  (featureFlags as Record<string, { description: string }>)[key].description;
export const isFlagKey = (key: string): key is FlagKey => Object.hasOwn(featureFlags, key);

/** Whether each flag is on for the signed-in account on this app; absent means off. */
export const flagStatesSchema = z.record(z.string(), z.boolean());
export type FlagStates = z.infer<typeof flagStatesSchema>;

export const flagMode = z.enum(['OFF', 'TARGETED', 'ON']);
/** App families with their own release cadence; the web app is always current. */
export const flagClient = z.enum(['DESKTOP', 'IOS', 'ANDROID']);
export const MAX_FLAG_USERS = 1000;
const version = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+){0,3}$/, 'Use a version like 1.4.0.');
export const flagRuleSchema = z.object({
  mode: flagMode,
  /** Accounts that always have the flag while it is targeted. */
  userIds: z.array(z.string().min(1).max(128)).max(MAX_FLAG_USERS),
  /** Share of every other account, 0–100; an account's place is fixed, so raising it only adds. */
  percent: z.number().int().min(0).max(100),
  /** Oldest app build that has the feature; older builds see the flag as off. */
  minVersions: z.partialRecord(flagClient, version),
});
/** Why a flag is on or off for one account. */
export const flagReason = z.enum([
  'OFF',
  'ALLOWLIST',
  'PERCENT',
  'EVERYONE',
  'NOT_SELECTED',
  'APP_TOO_OLD',
]);
export type FlagReason = z.infer<typeof flagReason>;
export type FlagMode = z.infer<typeof flagMode>;
export type FlagClient = z.infer<typeof flagClient>;
export type FlagRule = z.infer<typeof flagRuleSchema>;
export const defaultFlagRule = (): FlagRule => ({
  mode: 'OFF',
  userIds: [],
  percent: 0,
  minVersions: {},
});

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
    usage: {
      TOTP_SETUP_STARTED: 'Started setting up an authenticator app',
      TOTP_TURNED_ON: 'Turned on the authenticator app',
      EMAIL_TURNED_ON: 'Turned on email codes',
      TURNED_OFF: 'Turned off two-step verification',
      SIGNED_IN: 'Signed in with a code',
      CODE_REJECTED: 'Entered a wrong code',
      APP_UNSUPPORTED: 'Blocked: app has no two-step support',
    },
  },
} as const satisfies Record<string, FlagDefinition>;
type FlagDefinition = {
  /** What staff see for it in the console. */
  description: string;
  /** Events the feature records in its usage log, with how the console names them. */
  usage?: Record<string, string>;
};
export type FlagKey = keyof typeof featureFlags;
/** Every defined flag; read when needed, so tests can define their own. */
export const flagKeys = () => Object.keys(featureFlags) as FlagKey[];
const definition = (key: FlagKey) => (featureFlags as Record<string, FlagDefinition>)[key];
export const flagDescription = (key: FlagKey) => definition(key).description;
/** How the console names a usage event; unknown events show as recorded. */
export const flagUsageLabel = (key: FlagKey, event: string) =>
  definition(key)?.usage?.[event] ?? event;
/** Usage events a flag records, as written in its definition. */
export type FlagUsageEvent<K extends FlagKey> = K extends keyof typeof featureFlags
  ? (typeof featureFlags)[K] extends { usage: infer U }
    ? keyof U & string
    : never
  : never;
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

/** One use of a flagged feature, for staff to see who is using it. Kept for 180 days. */
export const flagUsageSchema = z.object({
  id: z.string(),
  at: z.string(),
  event: z.string(),
  /** Event name as the console shows it. */
  label: z.string(),
  /** Null when the account isn't known yet, e.g. a code entered before sign-in finishes. */
  userId: z.string().nullable(),
  email: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export const flagUsagePageSchema = z.object({
  items: z.array(flagUsageSchema),
  nextCursor: z.string().nullable(),
});
export type FlagUsage = z.infer<typeof flagUsageSchema>;
export type FlagUsagePage = z.infer<typeof flagUsagePageSchema>;

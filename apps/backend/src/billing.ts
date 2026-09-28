import { FREE_QUOTA } from '@harbor/contracts';
import { StorageService, userPK } from './domain';
import { assert } from './errors';
export interface BillingProvider {
  checkout(userId: string, planId: string, returnUrl: string): Promise<{ checkoutUrl: string }>;
  verifyWebhook(
    rawBody: string,
    signature: string,
  ): Promise<{ eventId: string; userId: string; totalQuotaBytes: number; occurredAt: string }>;
}
// Only a verified provider webhook or trusted operator job may call this service.
// No public endpoint accepts client-supplied entitlements.
export async function applyEntitlement(
  service: StorageService,
  event: { eventId: string; userId: string; totalQuotaBytes: number; occurredAt: string },
) {
  assert(
    Number.isSafeInteger(event.totalQuotaBytes) && event.totalQuotaBytes >= FREE_QUOTA,
    'VALIDATION_ERROR',
    'Invalid storage entitlement.',
  );
  return service.operation(
    event.userId,
    `billing-${event.eventId}`,
    { action: 'entitlement', ...event },
    async (tx) => {
      const previous = await tx.get<{ occurredAt: string }>(userPK(event.userId), 'ENTITLEMENT');
      if (previous && previous.occurredAt > event.occurredAt) return { applied: false };
      const account = await service.account(tx, event.userId);
      account.storageQuotaBytes = event.totalQuotaBytes;
      await tx.put(userPK(event.userId), 'PROFILE', account);
      await tx.put(userPK(event.userId), 'ENTITLEMENT', {
        baseFreeBytes: FREE_QUOTA,
        paidBytes: event.totalQuotaBytes - FREE_QUOTA,
        totalQuotaBytes: event.totalQuotaBytes,
        occurredAt: event.occurredAt,
      });
      await service.record(tx, event.userId, 'BILLING_PLAN_CHANGED', event.userId);
      return { applied: true };
    },
  );
}

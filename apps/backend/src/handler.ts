import { handle, type LambdaEvent, type LambdaContext } from 'hono/aws-lambda';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { runtime, realtimeRuntime, adminRuntime, mailEventRuntime } from './runtime';
import type { SesEventDetail } from './email-preferences';
import { costExplorerSource, refreshCostsIfDue } from './platform-costs';
export async function handler(event: LambdaEvent, context: LambdaContext) {
  return handle((await runtime()).app)(event, context);
}
export async function admin(event: LambdaEvent, context: LambdaContext) {
  return handle(adminRuntime())(event, context);
}
export async function jobs() {
  const r = await runtime();
  // The daily cost figures for the console; a failure here must not hold up user jobs.
  const costs = refreshCostsIfDue(r.service.repo, {
    aws: costExplorerSource(),
    objects: () => r.service.storage.inventory(),
  }).catch((error) => console.error('Platform cost check failed', error));
  const result = await r.service.runJobs(r.sendEmail, {
    emailLinks: r.emailLinks,
    ratePerSecond: r.campaignRate,
  });
  await costs;
  return result;
}
type SocketEvent = {
  requestContext: { routeKey: string; connectionId: string };
  queryStringParameters?: Record<string, string | undefined> | null;
};
export async function realtimeSocket(event: SocketEvent) {
  const { routeKey, connectionId } = event.requestContext;
  const realtime = realtimeRuntime();
  if (routeKey === '$connect') {
    try {
      await realtime.connect(connectionId, event.queryStringParameters?.ticket);
      return { statusCode: 200 };
    } catch {
      return { statusCode: 401 };
    }
  }
  if (routeKey === '$disconnect') await realtime.disconnect(connectionId);
  // Anything else is a keep-alive ping; API Gateway drops connections idle for 10 minutes.
  return { statusCode: 200 };
}
export async function realtimeStream(event: DynamoDBStreamEvent) {
  const keys = event.Records.filter((record) => record.eventName !== 'REMOVE').flatMap((record) => {
    const key = record.dynamodb?.Keys;
    return key?.pk?.S && key.sk?.S ? [{ pk: key.pk.S, sk: key.sk.S }] : [];
  });
  if (keys.length) await realtimeRuntime().publish(keys);
}

// Hard bounces and spam complaints keep the address out of later optional email.
export async function mailEvent(event: { detail?: SesEventDetail }) {
  if (event.detail) await mailEventRuntime()(event.detail);
}

export { preSignup, postConfirmation } from './registration';
export { customMessage } from './emails';

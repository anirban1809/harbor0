import { handle, type LambdaEvent, type LambdaContext } from 'hono/aws-lambda';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { runtime, realtimeRuntime } from './runtime';
export async function handler(event: LambdaEvent, context: LambdaContext) {
  return handle((await runtime()).app)(event, context);
}
export async function jobs() {
  const r = await runtime();
  return r.service.runJobs(r.sendEmail);
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

export { preSignup } from './registration';

import { handle, type LambdaEvent, type LambdaContext } from 'hono/aws-lambda';
import { runtime } from './runtime';
export async function handler(event: LambdaEvent, context: LambdaContext) {
  return handle((await runtime()).app)(event, context);
}
export async function jobs() {
  const r = await runtime();
  return r.service.runJobs(r.sendEmail);
}

export { preSignup } from './registration';

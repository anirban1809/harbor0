export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
  details?: unknown,
): asserts condition {
  if (!condition) throw new DomainError(code, message, status, details);
}
export class RetryTransaction extends Error {}

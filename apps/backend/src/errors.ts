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
/** The owner of a shared folder lacks space for someone else's addition; `notice` is for the owner. */
export class OwnerStorageFull extends DomainError {
  constructor(
    public ownerId: string,
    public notice: Record<string, unknown>,
  ) {
    super('OWNER_STORAGE_FULL', 'The owner of this shared folder is out of storage.', 409);
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

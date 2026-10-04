import { ApiError, SESSION_DURATION_SECONDS } from '@harbor/api-client';

type Tokens = { accessToken: string; refreshToken: string; expiresIn: number };
export type SavedSession = { refreshToken: string; expiresAt: number };

/** A failed session renewal, as opposed to a failed request made with the session. */
export class RenewalError extends ApiError {}

export function isSessionError(error: unknown) {
  return (
    error instanceof ApiError &&
    (error.status === 401 || ['AUTH_INVALID', 'DEVICE_REVOKED'].includes(error.code))
  );
}

/** Only the refresh credential is persisted, through the OS keychain. */
export class DesktopSession {
  private accessToken = '';
  private accessExpiresAt = 0;
  private saved?: SavedSession;
  private refreshing?: Promise<void>;
  private generation = 0;

  constructor(
    private options: {
      renew: (refreshToken: string) => Promise<Tokens>;
      persist: (saved: SavedSession) => Promise<void>;
      clear: () => Promise<void>;
      signedOut: () => void;
    },
  ) {}

  get refreshToken() {
    return this.saved?.refreshToken ?? '';
  }
  get signedIn() {
    return !!this.accessToken && !!this.saved && Date.now() < this.saved.expiresAt;
  }

  async signIn(tokens: Tokens) {
    this.generation++;
    await this.save(tokens, Date.now() + SESSION_DURATION_SECONDS * 1000);
  }

  async restore(saved: SavedSession) {
    this.saved = saved;
    await this.refresh();
  }

  private async save(tokens: Tokens, expiresAt: number) {
    if (!tokens.accessToken || !tokens.refreshToken || !(tokens.expiresIn > 0)) {
      await this.invalidate();
      throw this.expired();
    }
    const saved = { refreshToken: tokens.refreshToken, expiresAt };
    await this.options.persist(saved);
    this.saved = saved;
    this.accessToken = tokens.accessToken;
    this.accessExpiresAt = Date.now() + tokens.expiresIn * 1000;
  }

  private expired() {
    return new ApiError('AUTH_INVALID', 'Your session expired. Sign in again.', 401);
  }

  async invalidate() {
    this.generation++;
    this.accessToken = '';
    this.accessExpiresAt = 0;
    this.saved = undefined;
    this.options.signedOut();
    await this.options.clear();
  }

  async token() {
    if (
      !this.saved?.refreshToken ||
      !Number.isFinite(this.saved.expiresAt) ||
      Date.now() >= this.saved.expiresAt
    ) {
      await this.invalidate();
      throw this.expired();
    }
    if (!this.accessToken || Date.now() >= this.accessExpiresAt - 30_000) await this.refresh();
    return this.accessToken;
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    const saved = this.saved;
    if (
      !saved?.refreshToken ||
      !Number.isFinite(saved.expiresAt) ||
      Date.now() >= saved.expiresAt
    ) {
      await this.invalidate();
      throw this.expired();
    }
    const generation = this.generation;
    this.refreshing = (async () => {
      try {
        const tokens = await this.options.renew(saved.refreshToken);
        // A late refresh response must not sign the user back in after logout.
        if (generation !== this.generation) throw this.expired();
        await this.save(tokens, saved.expiresAt);
      } catch (error) {
        if (generation === this.generation && isSessionError(error)) await this.invalidate();
        throw error;
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
}

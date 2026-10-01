export type LiveMessage = { type: 'changes' | 'notification' };
type Socket = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
};
type Options = {
  ticket: () => Promise<{ url: string; ticket: string }>;
  onMessage: (message: LiveMessage) => void;
  /** Called on every connect and disconnect; a reconnect may have missed messages. */
  onConnected: (connected: boolean) => void;
  socket?: (url: string) => Socket;
};
// API Gateway drops connections idle for 10 minutes.
export const LIVE_PING_MS = 5 * 60_000;
const RETRY_MIN = 1000;
const RETRY_MAX = 60_000;
// When the server has no live updates configured, polling covers everything; ask rarely.
const UNAVAILABLE_RETRY = 10 * 60_000;

/** Holds the live updates connection; messages are hints to check the server now. */
export class LiveUpdates {
  connected = false;
  private socket?: Socket;
  private stopped = true;
  private attempts = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  constructor(private options: Options) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.close();
  }
  private close() {
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onclose = socket.onerror = socket.onmessage = socket.onopen = null;
      socket.close();
    }
    this.setConnected(false);
  }
  private setConnected(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected;
    this.options.onConnected(connected);
  }
  private retry(delay?: number) {
    this.close();
    if (this.stopped || this.retryTimer) return;
    const backoff = Math.min(RETRY_MAX, RETRY_MIN * 2 ** this.attempts++);
    // Jitter keeps many clients from reconnecting at the same instant after an outage.
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.connect();
      },
      delay ?? backoff * (0.5 + Math.random() / 2),
    );
  }
  private async connect() {
    if (this.stopped) return;
    let ticket: { url: string; ticket: string };
    try {
      ticket = await this.options.ticket();
    } catch (error) {
      const unavailable = (error as { code?: string }).code === 'REALTIME_UNAVAILABLE';
      this.retry(unavailable ? UNAVAILABLE_RETRY : undefined);
      return;
    }
    if (this.stopped) return;
    let socket: Socket;
    try {
      // A response without a socket address is treated like an unavailable server.
      if (typeof ticket?.url !== 'string' || typeof ticket.ticket !== 'string')
        throw new Error('Invalid live updates ticket.');
      const url = `${ticket.url}${ticket.url.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket.ticket)}`;
      socket = this.options.socket?.(url) ?? (new WebSocket(url) as unknown as Socket);
    } catch {
      this.retry(UNAVAILABLE_RETRY);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.setConnected(true);
      this.pingTimer = setInterval(() => {
        try {
          socket.send(JSON.stringify({ type: 'ping' }));
        } catch {
          this.retry();
        }
      }, LIVE_PING_MS);
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type === 'changes' || message?.type === 'notification')
          this.options.onMessage({ type: message.type });
      } catch {
        /* Ignore anything that is not a live update. */
      }
    };
    socket.onclose = () => this.retry();
    socket.onerror = () => this.retry();
  }
}

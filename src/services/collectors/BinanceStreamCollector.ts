import fs from "fs";
import path from "path";

import cryptoConfig from "../../config/crypto.config";
import { log, Colors } from "../../utils/colored-console";
import { RollingGzipWriter } from "./RollingGzipWriter";

const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * One Binance WebSocket stream recorded to disk. Handles what a long-running recorder needs:
 * reconnects with backoff (Binance also drops every connection after 24h), a watchdog for silent
 * connections, and a gaps journal (`gaps.jsonl`) so a model later knows where data is missing.
 * Subclasses only turn a message into rows.
 */
export abstract class BinanceStreamCollector {
  protected readonly writer: RollingGzipWriter;
  private readonly dir: string;
  private ws: WebSocket | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private disconnectedAt: number | null = null;
  private reconnectDelay = 1000;
  private stopped = false;
  public reconnects = 0;

  constructor(
    public readonly name: string, // e.g. "ETH-USDT/futures-trades"
    private readonly url: string,
    // how long the stream may stay silent before the connection is considered dead
    private readonly silenceTimeoutMs = cryptoConfig.collectors.silenceTimeoutSeconds * 1000
  ) {
    this.dir = path.join(cryptoConfig.collectors.storageDir, name);
    fs.mkdirSync(this.dir, { recursive: true });
    this.writer = new RollingGzipWriter(this.dir);
  }

  /** Converts one stream message into stored rows. */
  protected abstract handle(message: any, receivedAt: number): void;

  public get rows(): number {
    return this.writer.rows;
  }

  private journal(entry: Record<string, unknown>) {
    fs.appendFileSync(path.join(this.dir, "gaps.jsonl"), JSON.stringify(entry) + "\n");
  }

  public start(): void {
    this.journal({ type: "start", at: Date.now() });
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws && this.lastMessageAt && Date.now() - this.lastMessageAt > this.silenceTimeoutMs) {
        log(`[collector] ${this.name}: no data for ${this.silenceTimeoutMs / 1000}s, reconnecting`, Colors.YELLOW);
        this.reconnectNow();
      }
    }, 10_000);
  }

  /**
   * Abandons the current socket and opens a new one right away. A dead connection (network drop, sleep)
   * may never finish the close handshake, so waiting for its close event used to delay reconnects 20–30 min.
   */
  private reconnectNow(): void {
    const dead = this.ws;
    this.ws = null; // its close event, if it ever comes, is ignored
    this.disconnectedAt ??= this.lastMessageAt || Date.now();
    // the new socket gets a full silence window before it is judged too
    this.lastMessageAt = Date.now();
    this.reconnects++;
    try {
      dead?.close();
    } catch {
      // already broken
    }
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.disconnectedAt) {
        this.journal({ type: "gap", from: this.disconnectedAt, to: Date.now() });
        log(`[collector] ${this.name}: reconnected after ${((Date.now() - this.disconnectedAt) / 1000).toFixed(1)}s`, Colors.GREEN);
      }
      this.disconnectedAt = null;
      this.reconnectDelay = 1000;
      this.lastMessageAt = Date.now();
    };

    ws.onmessage = (event) => {
      const receivedAt = Date.now();
      this.lastMessageAt = receivedAt;
      try {
        this.handle(JSON.parse(String(event.data)), receivedAt);
      } catch (error) {
        log(`[collector] ${this.name}: cannot process message: ${error}`, Colors.RED);
      }
    };

    ws.onerror = () => {
      // details arrive with the close event that always follows
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.disconnectedAt ??= this.lastMessageAt || Date.now();
      this.reconnects++;
      log(
        `[collector] ${this.name}: connection closed (${event.code}${event.reason ? ` ${event.reason}` : ""}), ` +
          `retry in ${this.reconnectDelay / 1000}s`,
        Colors.YELLOW
      );
      setTimeout(() => !this.stopped && this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    };
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
    this.journal({ type: "stop", at: Date.now() });
    await this.writer.close();
  }
}

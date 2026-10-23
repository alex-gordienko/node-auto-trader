import axios from "axios";
import fs from "fs";
import path from "path";

import cryptoConfig from "../../config/crypto.config";
import { createLogger, Colors } from "../../utils/colored-console";
import { RollingGzipWriter } from "./RollingGzipWriter";

const log = createLogger("options");

/**
 * Snapshots of every listed option of a currency on Deribit (the largest crypto options exchange), taken every few
 * minutes. Implied volatility per strike and expiry gives the skew later: how much more traders pay for protection
 * against a fall (puts) than for a bet on a rise (calls). Deribit has no free history of it, so it is recorded.
 * Row: [receivedAtMs, [[instrument, markIv, underlyingPrice, bidPrice, askPrice, openInterest, volume], ...]];
 * instrument "ETH-27NOV26-2400-P" = currency, expiry, strike, put / call; prices are in the currency (ETH).
 */
export class DeribitOptionsRecorder {
  public readonly name: string;
  public reconnects = 0; // failed snapshots
  private readonly dir: string;
  private readonly writer: RollingGzipWriter;
  private timer: NodeJS.Timeout | null = null;
  private failingSince: number | null = null;

  constructor(private readonly currency: string) {
    this.name = `DERIBIT/${currency}-options`;
    this.dir = path.join(cryptoConfig.collectors.storageDir, this.name);
    fs.mkdirSync(this.dir, { recursive: true });
    // one row per snapshot: flushing more often than snapshots arrive is pointless
    this.writer = new RollingGzipWriter(this.dir, 60);
  }

  public get rows(): number {
    return this.writer.rows;
  }

  private journal(entry: Record<string, unknown>) {
    fs.appendFileSync(path.join(this.dir, "gaps.jsonl"), JSON.stringify(entry) + "\n");
  }

  private snapshot = async (): Promise<void> => {
    try {
      const response = await axios.get<{ result: any[] }>(`${cryptoConfig.marketData.deribitApiUrl}/public/get_book_summary_by_currency`, {
        params: { currency: this.currency, kind: "option" },
        timeout: 15000,
      });
      const receivedAt = Date.now();
      const options = response.data.result.map((o) => [
        o.instrument_name,
        o.mark_iv,
        o.underlying_price,
        o.bid_price,
        o.ask_price,
        o.open_interest,
        o.volume,
      ]);
      this.writer.write([receivedAt, options], receivedAt);
      if (this.failingSince) {
        this.journal({ type: "gap", from: this.failingSince, to: receivedAt });
        this.failingSince = null;
      }
    } catch (error: any) {
      this.failingSince ??= Date.now();
      this.reconnects++;
      log(`${this.name}: snapshot failed: ${error?.message}`, Colors.YELLOW);
    }
  };

  public start(): void {
    this.journal({ type: "start", at: Date.now() });
    this.snapshot();
    this.timer = setInterval(this.snapshot, cryptoConfig.collectors.optionsSnapshotSeconds * 1000);
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.journal({ type: "stop", at: Date.now() });
    await this.writer.close();
  }
}

import fs from "fs";
import path from "path";
import zlib from "zlib";

/**
 * Appends JSON rows to gzip files rotated every hour: <dir>/<yyyy-MM-dd>/<HH>.jsonl.gz (UTC, by receive time).
 * A restart within the same hour appends a new gzip member to the same file — gunzip reads them as one stream.
 * Data is flushed to disk regularly, so a crash loses at most a few seconds.
 */
export class RollingGzipWriter {
  private current: { key: string; gzip: zlib.Gzip; file: fs.WriteStream } | null = null;
  private readonly flushTimer: NodeJS.Timeout;
  public rows = 0;

  constructor(
    private readonly dir: string,
    flushSeconds = 10
  ) {
    this.flushTimer = setInterval(() => this.current?.gzip.flush(zlib.constants.Z_SYNC_FLUSH), flushSeconds * 1000);
  }

  public write(row: unknown, receivedAt = Date.now()): void {
    const iso = new Date(receivedAt).toISOString();
    const day = iso.slice(0, 10);
    const hour = iso.slice(11, 13);
    const key = `${day}/${hour}`;

    if (this.current?.key !== key) {
      this.endCurrent();
      fs.mkdirSync(path.join(this.dir, day), { recursive: true });
      const file = fs.createWriteStream(path.join(this.dir, day, `${hour}.jsonl.gz`), { flags: "a" });
      const gzip = zlib.createGzip();
      gzip.pipe(file);
      this.current = { key, gzip, file };
    }

    this.current.gzip.write(JSON.stringify(row) + "\n");
    this.rows++;
  }

  private endCurrent(): void {
    this.current?.gzip.end();
    this.current = null;
  }

  /** Finishes the open file so it is a complete gzip archive. */
  public close(): Promise<void> {
    clearInterval(this.flushTimer);
    const current = this.current;
    this.current = null;
    if (!current) return Promise.resolve();
    return new Promise((resolve) => {
      current.file.on("close", () => resolve());
      current.gzip.end();
    });
  }
}

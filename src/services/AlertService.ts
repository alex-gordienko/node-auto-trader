import axios from "axios";
import { Colors, createLogger } from "../utils/colored-console";

const log = createLogger("alert");

export type AlertSeverity = "critical" | "warning";

const DEBOUNCE_MS = 30 * 60_000;

/**
 * `notify(severity, key, message)` — per-`key` debounced so a flapping stream cannot spam. Defaults to log-only
 * (no credential needed to land or test this). Set `ALERT_WEBHOOK_URL` to also POST to a webhook (Slack-compatible
 * `{text}` body); a failed webhook post is itself only logged, never thrown, so alerting can never crash the
 * caller it is meant to warn about.
 */
class AlertService {
  private readonly lastSentAt = new Map<string, number>();

  public notify = (severity: AlertSeverity, key: string, message: string): void => {
    const now = Date.now();
    const last = this.lastSentAt.get(key) ?? 0;
    if (now - last < DEBOUNCE_MS) return;
    this.lastSentAt.set(key, now);

    log(`[${severity.toUpperCase()}] ${key}: ${message}`, severity === "critical" ? Colors.RED : Colors.YELLOW);

    const webhookUrl = process.env.ALERT_WEBHOOK_URL;
    if (!webhookUrl) return;
    axios.post(webhookUrl, { text: `[${severity.toUpperCase()}] ${key}: ${message}` }).catch((error) => {
      log(`webhook post failed: ${error}`, Colors.RED);
    });
  };
}

export default new AlertService();

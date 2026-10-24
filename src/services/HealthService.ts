import cryptoConfig from "../config/crypto.config";

export type HealthStatus = "ok" | "degraded" | "down";

export interface IHealthReport {
  status: HealthStatus;
  reasons: string[];
  lastPriceAt: number | null;
  lastRebalanceCheckAt: number | null;
  lastFillAt: number | null;
  collectorRestarts: number;
  collectorLocked: boolean;
  stopFile: { active: boolean; reason: string | null };
}

/**
 * In-process registry of heartbeats, written by the components that already know (Rebalance.service, the
 * collectors' worker lifecycle). Exists so `GET /api/v1/health?deep=1` can answer "is anything actually broken"
 * instead of only "is the process alive" — the gap that let a locked-collector or a silent price outage look
 * healthy to an uptime checker (see TRA-16 plan §5).
 */
class HealthService {
  private lastPriceAt: number | null = null;
  private lastRebalanceCheckAt: number | null = null;
  private lastFillAt: number | null = null;
  private collectorRestarts = 0;
  private collectorLocked = false;
  private stopActive = false;
  private stopReason: string | null = null;

  public recordPrice = (): void => {
    this.lastPriceAt = Date.now();
  };

  public recordRebalanceCheck = (): void => {
    this.lastRebalanceCheckAt = Date.now();
  };

  public recordFill = (): void => {
    this.lastFillAt = Date.now();
  };

  public recordCollectorRestart = (): void => {
    this.collectorRestarts++;
  };

  public recordCollectorLocked = (): void => {
    this.collectorLocked = true;
  };

  public recordStop = (reason: string | null): void => {
    this.stopActive = reason !== null;
    this.stopReason = reason;
  };

  public getReport = (): IHealthReport => {
    const reasons: string[] = [];
    // the rebalance check should fire every `checkMinutes`; three missed cycles is a real outage, not a slow tick
    const staleMs = cryptoConfig.rebalance.checkMinutes * 60_000 * 3;
    const now = Date.now();

    if (this.collectorLocked) reasons.push("collectors locked: a second instance left the process with no collectors");
    if (this.lastRebalanceCheckAt === null) reasons.push("rebalance check has never run");
    else if (now - this.lastRebalanceCheckAt > staleMs) reasons.push(`rebalance check stale (last at ${new Date(this.lastRebalanceCheckAt).toISOString()})`);
    if (this.lastPriceAt !== null && now - this.lastPriceAt > staleMs) reasons.push(`price feed stale (last at ${new Date(this.lastPriceAt).toISOString()})`);

    const down = this.collectorLocked || reasons.some((r) => r.includes("never run") || r.includes("stale"));
    const degraded = !down && (this.stopActive || this.collectorRestarts > 0);
    if (this.stopActive) reasons.push(`stop-crane active: ${this.stopReason}`);

    return {
      status: down ? "down" : degraded ? "degraded" : "ok",
      reasons,
      lastPriceAt: this.lastPriceAt,
      lastRebalanceCheckAt: this.lastRebalanceCheckAt,
      lastFillAt: this.lastFillAt,
      collectorRestarts: this.collectorRestarts,
      collectorLocked: this.collectorLocked,
      stopFile: { active: this.stopActive, reason: this.stopReason },
    };
  };
}

export default new HealthService();

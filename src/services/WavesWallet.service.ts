import {
  // nodeInteraction,
  broadcast,
  transfer,
  WithId,
  WithProofs,
} from "@waves/waves-transactions";
import https from "https";
import { TransferTransaction } from "@waves/ts-types";
import { log, Colors } from "../utils/colored-console";
import repeatEvent from "../utils/timer";
import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import { walletAmountStatistic } from "../utils/walletAmountStatistic";
import cryptoConfig from "../config/crypto.config";
import { CryptoBase } from "../types/basic.types";
import axios from "axios";

const agent = new https.Agent({
  rejectUnauthorized: false,
});

class WavesWalletService {
  private readonly wavesWallet = cryptoConfig.wavesWallet;
  private readonly wavesPrivateKey = cryptoConfig.wavesPrivateKey;

  private readonly wavesNodeUrl = "https://nodes.wavesnodes.com";

  private walletTimer: NodeJS.Timeout | null = null;

  constructor() {
    log("[*] Initializing Waves Wallet Service", Colors.YELLOW);

    this.startAutoUpdate();
    this.getBalance();
  }

  public stopWalletTimer = () => {
    if (this.walletTimer) {
      clearInterval(this.walletTimer);
    }
  };

  public convertLongToWaves = (amount?: number | string): number => { 
    return amount ? Number(String(amount)) / Math.pow(10, 8) : 0;
  }

  public getAddress = (): string => { 
    return this.wavesWallet;
  }

  private startAutoUpdate = async () => {
    const units = cryptoConfig.autoUpdateWalletBalanceInterval.units;
    const interval = cryptoConfig.autoUpdateWalletBalanceInterval.interval;

    log(`[**] Wallet balance would be auto-updated each ${interval} ${units}`, Colors.YELLOW);

    this.walletTimer = repeatEvent({
      callback: async () => {
        // get history for statistics
        const walletHistory = await DigitalOceanStorageService.getWalletBalanceHistory(CryptoBase.WAVES);

        // get current balance
        const balance = await this.getBalance();

        walletAmountStatistic(CryptoBase.WAVES, balance, walletHistory);

        // push new value to DigitalOcean
        await DigitalOceanStorageService.pushWalletBalanceHistory(CryptoBase.WAVES, {
          amount: balance,
          timestamp: new Date().getTime(),
        });
      },
      units,
      interval,
    });
  };

  public getBalance = async (): Promise<number> => {
    try {
      const response = await axios.get(`${this.wavesNodeUrl}/addresses/balance/${this.wavesWallet}`, {
        httpsAgent: agent,
      });
      const balance = response.data.balance;

      return balance / Math.pow(10, 8);
    } catch (error) {
      log('Error while get Waves balance', Colors.RED);
      log(error, Colors.RED);
      return 0;
    }
  };

  public sendCoins = async (
    walletTo: string,
    amount: number
  ): Promise<(TransferTransaction & WithId & WithProofs) | null> => {
    try {
      const tx = await transfer(
        {
          recipient: walletTo,
          amount: amount * Math.pow(10, 8),
          fee: 100000,
        },
        { privateKey: this.wavesPrivateKey }
      );

      await broadcast(tx, this.wavesNodeUrl);

      log(`[***] Transaction successfully sent. TX hash: ${tx.id}`, Colors.CYAN);
      return tx;
    } catch (error) {
      log(`Error while sending coins`, Colors.RED);
      log(error, Colors.RED);
      return null;
    }
  };
}

export default new WavesWalletService();

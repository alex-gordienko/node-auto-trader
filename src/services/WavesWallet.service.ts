import {
  // nodeInteraction,
  // broadcast,
  transfer,
  WithId,
  WithProofs,
} from "@waves/waves-transactions";
import https from "https";
import { TransferTransaction } from "@waves/ts-types";
import { log, Colors } from "../utils/colored-console";
import cryptoConfig from "../config/crypto.config";
import axios, { AxiosError } from "axios";

const agent = new https.Agent({
  rejectUnauthorized: false,
});

class WavesWalletService {
  private readonly wavesWallet = cryptoConfig.wavesWallet;
  private readonly wavesPrivateKey = cryptoConfig.wavesPrivateKey;

  private readonly wavesNodeUrl = "https://nodes.wavesnodes.com";

  constructor() {
    log("[*] Initializing Waves Wallet Service", Colors.YELLOW);
    this.getBalance();
  }

  public convertLongToWaves = (amount?: number | string): number => { 
    return amount ? Number(String(amount)) / Math.pow(10, 8) : 0;
  }

  public getAddress = (): string => { 
    return this.wavesWallet;
  }

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

      const response = await axios.post(`${this.wavesNodeUrl}/transactions/broadcast`, tx, { httpsAgent: agent });

      log(`[***] Transaction successfully sent. TX hash: ${response.data.id}`, Colors.CYAN);
      return response.data;
    } catch (error) {
      log(`Error while sending coins`, Colors.RED);

      if (error instanceof AxiosError) {
        log(error.response?.data, Colors.RED);
      } else {
        log(error, Colors.RED);
      }
      return null;
    }
  };
}

export default new WavesWalletService();

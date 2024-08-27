import * as Ethers from "ethers";
import { log, Colors } from "../utils/colored-console";
import repeatEvent from "../utils/timer";
import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import { walletAmountStatistic } from "../utils/walletAmountStatistic";
import cryptoConfig from "../config/crypto.config";

class MoneroWalletService {
  private readonly infuraAPIkey = cryptoConfig.infuraApiKey;
  private readonly moneroPrivateKey = cryptoConfig.moneroPrivateKey;

  private wallet: Ethers.ethers.Wallet;
  private walletTimer: NodeJS.Timeout | null = null;

  constructor() {
    log("[*] Initializing Monero Wallet Service", Colors.YELLOW);

    const provider = new Ethers.JsonRpcProvider(
      `https://mainnet.infura.io/v3/${this.infuraAPIkey}`
    );

    const wallet = new Ethers.ethers.Wallet(this.moneroPrivateKey, provider);

    this.wallet = wallet;

    this.startAutoUpdate();
  }

  private static convertBigIntToXMR = (balance: bigint) =>
    Ethers.ethers.formatEther(balance);

  public stopWalletTimer = () => {
    if (this.walletTimer) {
      clearInterval(this.walletTimer);
    }
  };

  private startAutoUpdate = async () => {
    const units = "minutes";
    const interval = 11;

    log(
      `[**] Wallet balance would be auto-updated each ${interval} ${units}`,
      Colors.YELLOW
    );

    this.walletTimer = repeatEvent({
      callback: async () => {
        // get history for statistics
        const walletHistory =
          await DigitalOceanStorageService.getWalletBalanceHistory("XMR");

        // get current balance
        const balance = await this.getBalance();

        walletAmountStatistic("XMR", balance, walletHistory);

        // push new value to DigitalOcean
        await DigitalOceanStorageService.pushWalletBalanceHistory("XMR", {
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
      if (this.wallet.provider) {
        const balance = await this.wallet.provider?.getBalance(this.wallet.address);

        return Number(MoneroWalletService.convertBigIntToXMR(balance));
      }
      return 0;
    } catch (error) {
      log(`Error while get balance: ${error}`, Colors.RED);
      return 0;
    }
  };

  public sendCoins = async (
    walletTo: string,
    amount: number
  ): Promise<Ethers.ethers.TransactionResponse | null> => {
    try {
      const tx = await this.wallet.sendTransaction({
        to: walletTo,
        value: Ethers.ethers.parseEther(amount.toString()),
      });

      await tx.wait();
      log(
        `[***] Transaction successfully sent. TX hash: ${tx.hash}`,
        Colors.CYAN
      );
      return tx;
    } catch (error) {
      log(`Error while sending coins`, Colors.RED);
      log(error, Colors.RED);
      return null;
    }
  };
}

export default new MoneroWalletService();

import * as Ethers from "ethers";
import cryptoConfig from "../config/crypto.config";
import { log, Colors } from "../utils/colored-console";
import repeatEvent from "../utils/timer";
import DigitalOceanStorageService from "./DigitalOcean.storage.service";
import { walletAmountStatistic } from "../utils/walletAmountStatistic";

class EtheriumWallet {
  private readonly infuraAPIkey = cryptoConfig.infuraApiKey;
  private readonly etheriumPrivateKey = cryptoConfig.etheriumPrivateKey;
  private walletTimer: NodeJS.Timeout | null = null;

  private wallet: Ethers.ethers.Wallet;

  constructor() {
    log("[*] Initializing Etherium Wallet Service", Colors.CYAN);
    const provider = new Ethers.JsonRpcProvider(
      `https://mainnet.infura.io/v3/${this.infuraAPIkey}`
    );
    const wallet = new Ethers.ethers.Wallet(this.etheriumPrivateKey, provider);

    this.wallet = wallet;
    this.startAutoUpdate();
  }

  public stopWalletTimer = () => {
    if (this.walletTimer) {
      clearInterval(this.walletTimer);
    }
  };

  private startAutoUpdate = async () => {
    const units = cryptoConfig.autoUpdateWalletBalanceInterval.units;
    const interval = cryptoConfig.autoUpdateWalletBalanceInterval.interval;

    log(
      `[**] Wallet balance would be auto-updated each ${interval} ${units}`,
      Colors.CYAN
    );

    this.walletTimer = repeatEvent({
      callback: async () => {
        // get history for statistics
        const walletHistory = await DigitalOceanStorageService.getWalletBalanceHistory('ETH');

        // get current balance
        const balance = await this.getBalance();

        walletAmountStatistic("ETH", balance, walletHistory);

        // push new value to DigitalOcean
        await DigitalOceanStorageService.pushWalletBalanceHistory("ETH", {
          amount: balance,
          timestamp: new Date().getTime(),
        });
      },
      units,
      interval,
    });
  };

  private static convertBigIntToETH = (balance: bigint) =>
    Ethers.ethers.formatEther(balance);

  public getAddress(): string {
    return this.wallet.address;
  }

  public getPrivateKey(): string {
    return this.wallet.privateKey;
  }

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
      log(`[***] Transaction successfully sent. TX hash: ${tx.hash}`, Colors.CYAN);
      return tx;

    } catch (error) {
      log(`Error while sending coins`, Colors.RED);
      log(error, Colors.RED);
      return null;
    }
  };

  public getBalance = async (): Promise<number> => {
    try {
      if (this.wallet.provider) {
        const balance = await this.wallet.provider?.getBalance(this.wallet.address);

        return Number(EtheriumWallet.convertBigIntToETH(balance));
      }
      return 0;
    } catch (error) {
      log(`Error while get balance: ${error}`, Colors.RED);
      return 0;
    }
  };
}

export default new EtheriumWallet();

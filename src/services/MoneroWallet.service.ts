import Monero, { MoneroWalletFull } from "monero-ts";
import { log, Colors } from "../utils/colored-console";

class MoneroWalletService {
  private wallet: MoneroWalletFull | null = null;

  constructor() {
    log("[*] Initializing Monero Wallet Service", Colors.YELLOW);

    this.connectToWallet().then(async () => {
      await this.getBalance();
    });
  }

  private static convertBigIntToXMR = (balance: bigint) =>
    Number(balance) / 1000000000000;

  connectToWallet = async () => {
    try {
      const wallet = await Monero.openWalletFull({
        path: `${__dirname}/../miner/miner-wallet`,
        password: "Motherlode.15",
        networkType: Monero.MoneroNetworkType.MAINNET,
        server: {
          uri: "http://nodes.hashvault.pro:18081",
        },
      });

      this.wallet = wallet;

      log("[*] Monero Wallet connected", Colors.YELLOW);

      wallet.startSyncing(5000);
    } catch (error) {
      log("Error while create wallet", Colors.RED);
    }
  };

  getBalance = async () => {
    try {
      if (this.wallet) {
        const balance = await this.wallet.getBalance();
        log(
          `[**] Current wallet balance: ${MoneroWalletService.convertBigIntToXMR(balance)} XMR`,
          Colors.YELLOW
        );
      }
    } catch (error) {
      log("Error while get balance", Colors.RED);
    }
  };

  getTransactions = async () => {
    try {
      if (this.wallet) {
        const transactions = await this.wallet.getTxs();
        log(transactions, Colors.YELLOW);
      }
    } catch (error) {
      log("Error while get transactions", Colors.RED);
    }
  };
}

export default new MoneroWalletService();

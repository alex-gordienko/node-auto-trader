import * as Ethers from "ethers";
import cryptoConfig from "../config/crypto.config";
import { log, Colors } from "../utils/colored-console";

class EtheriumWallet {
  private readonly infuraAPIkey = cryptoConfig.infuraApiKey;
  private readonly etheriumPrivateKey = cryptoConfig.etheriumPrivateKey;

  private wallet: Ethers.ethers.Wallet;

  constructor() {
    log("[*] Initializing Etherium Wallet Service", Colors.CYAN);
    const provider = new Ethers.JsonRpcProvider(
      `https://mainnet.infura.io/v3/${this.infuraAPIkey}`
    );
    const wallet = new Ethers.ethers.Wallet(this.etheriumPrivateKey, provider);

    this.wallet = wallet;
    this.getBalance(wallet);
  }

  private static convertBigIntToETH = (balance: bigint) =>
    Ethers.ethers.formatEther(balance);

  public getAddress(): string {
    return this.wallet.address;
  }

  public getPrivateKey(): string {
    return this.wallet.privateKey;
  }

  public getBalance = async (wallet: Ethers.ethers.Wallet) => {
    try {
      if (wallet.provider) {
        const balance = await wallet.provider?.getBalance(wallet.address);
        log(
          `[**] Current wallet balance: ${EtheriumWallet.convertBigIntToETH(balance)} ETH`,
          Colors.CYAN
        );
      }
    } catch (error) {
      log(`Error while get balance: ${error}`, Colors.RED);
    }
  };
}

export default new EtheriumWallet();

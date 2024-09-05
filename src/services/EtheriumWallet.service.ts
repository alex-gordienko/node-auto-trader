import * as Ethers from "ethers";
import cryptoConfig from "../config/crypto.config";
import { log, Colors } from "../utils/colored-console";

class EtheriumWallet {
  private readonly infuraAPIkey = cryptoConfig.infuraApiKey;
  private readonly etheriumPrivateKey = cryptoConfig.etheriumPrivateKey;

  private wallet: Ethers.ethers.Wallet;

  constructor() {
    log("[*] Initializing Etherium Wallet Service", Colors.CYAN);
    const provider = new Ethers.JsonRpcProvider(`https://mainnet.infura.io/v3/${this.infuraAPIkey}`);
    const wallet = new Ethers.ethers.Wallet(this.etheriumPrivateKey, provider);

    this.wallet = wallet;
    this.getBalance();
  }

  public convertBigIntToETH = (balance: bigint) => Ethers.ethers.formatEther(balance);

  public getAddress(): string {
    return this.wallet.address;
  }

  public getPrivateKey(): string {
    return this.wallet.privateKey;
  }

  public sendCoins = async (walletTo: string, amount: number): Promise<Ethers.ethers.TransactionResponse | null> => {
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

        return Number(this.convertBigIntToETH(balance));
      }
      return 0;
    } catch (error) {
      log(`Error while get ETH balance: ${error}`, Colors.RED);
      return 0;
    }
  };

  public getTransactionFee = async (transactionHash: string): Promise<number> => {
    try {
      const receipt = await this.wallet.provider?.getTransactionReceipt(transactionHash);

      if(!receipt) {
        log(`[***] Transaction receipt not found`, Colors.RED);
        return 0;
      }

      const gasUsed = receipt.gasUsed;

      const transaction = await this.wallet.provider?.getTransaction(transactionHash);

      if(!transaction) {
        log(`[***] Transaction not found`, Colors.RED);
        return 0;
      }

      const gasPrice = transaction.gasPrice;

      const transactionFee = BigInt(gasUsed) * BigInt(gasPrice);

      return Number(Ethers.ethers.formatEther(transactionFee));

    } catch (error) {
      log(`Error while get transaction fee: ${error}`, Colors.RED);
      return 0;
    }
  };
}

export default new EtheriumWallet();

import axios from "axios";
import cryptoConfig from "../config/crypto.config";
import { log, Colors } from "../utils/colored-console";
import MoneroWalletService from "./BinanceWallet.service";
import EtheriumWalletService from "./EtheriumWallet.service";

class CryptoExchangeService {
  private readonly changeNOW_base_url: string = "https://api.changenow.io/v1";
  private readonly BNB_wallet: string = cryptoConfig.bnbWallet;
  private readonly ETH_wallet: string = cryptoConfig.etheriumWallet;
  private readonly changeNOW_api_key: string = cryptoConfig.changeNowApiKey;

  constructor() {
    log("[*] Initializing Crypto Exchange Service", Colors.MAGENTA);
    this.getAvailableTradePairs();
    this.minimalExchangeAmount("bnbbsc", "eth");
    this.minimalExchangeAmount("eth", "bnbbsc");
  }

  public getAvailableTradePairs = async (): Promise<boolean> => {
    try {
      const response = await axios.get(`${this.changeNOW_base_url}/market-info/available-pairs`, {
        headers: {
          "x-api-key": this.changeNOW_api_key,
        },
      });

      const isBNBETHAvailable = response.data.find((pair: string) => pair === "bnbbsc_eth");

      const isETHBNBAvailable = response.data.find((pair: string) => pair === "eth_bnbbsc");

      if (!isBNBETHAvailable) {
        log("BNB-ETH pair is not available", Colors.RED);
        return false;
      }

      if (!isETHBNBAvailable) {
        log("ETH-BNB pair is not available", Colors.RED);
        return false;
      }

      log("[**] BNB-ETH and ETH-BNB tradings are available", Colors.MAGENTA);
      return true;
    } catch (error) {
      log("Error getting available trade pairs", Colors.RED);
      log(error, Colors.RED);
      return false;
    }
  };

  public minimalExchangeAmount = async (from: "bnbbsc" | "eth", to: "bnbbsc" | "eth"): Promise<number> => {
    try {
      const response = await axios.get(`${this.changeNOW_base_url}/min-amount/${from}_${to}`, {
        headers: {
          "x-api-key": this.changeNOW_api_key,
        },
      });

      const minimalAmount = response.data.minAmount;
      log(`[**] Minimal exchange amount for ${from}-${to} pair is ${minimalAmount}`, Colors.MAGENTA);
      return minimalAmount as number;
    } catch (error) {
      log("Error getting minimal exchange amount", Colors.RED);
      log(error, Colors.RED);
      return 0;
    }
  };

  public changeBNBtoETH = async () => {
    log(`[**] Changing BNB to ETH`, Colors.MAGENTA);
    try {
      const isBNB_ETHAvailable = await this.getAvailableTradePairs();
      const minimalAmount = await this.minimalExchangeAmount("bnbbsc", "eth");

      if (!isBNB_ETHAvailable || minimalAmount === 0) {
        log("[***] BNB-ETH pair is not available or minimal amount is 0", Colors.RED);
        return;
      }

      const response = await axios.post(`${this.changeNOW_base_url}/transactions/${this.changeNOW_api_key}`, {
        from: "bnbbsc",
        to: "eth",
        amount: minimalAmount,
        address: this.ETH_wallet,
        flow: "standard",
      });

      const transactionData = response.data;
      log(`[***] Exchange transaction ID: ${transactionData.id}`, Colors.MAGENTA);
      log(`[***] Exchange temporal address: ${transactionData.payinAddress}`, Colors.MAGENTA);

      const transaction = await MoneroWalletService.sendCoins(transactionData.payinAddress, minimalAmount);

      if (transaction) {
        log(`[***] Exchange transaction hash: ${transaction.hash}`, Colors.MAGENTA);
      }

      return {
        exchangeAPIresponse: transactionData,
        moneroTransaction: transaction,
      };
    } catch (error) {
      log("Error changing BNB to ETH", Colors.RED);
      log(error, Colors.RED);
    }
  };

  public changeETHtoBNB = async () => {
    log(`[**] Changing ETH to BNB`, Colors.MAGENTA);
    try {
      const isETH_BNBavailable = await this.getAvailableTradePairs();
      const minimalAmount = await this.minimalExchangeAmount("eth", "bnbbsc");

      if (!isETH_BNBavailable || minimalAmount === 0) {
        log("[***] ETH-BNB pair is not available or minimal amount is 0", Colors.RED);
        return;
      }

      const response = await axios.post(`${this.changeNOW_base_url}/transactions/${this.changeNOW_api_key}`, {
        from: "eth",
        to: "bnbbsc",
        amount: minimalAmount,
        address: this.BNB_wallet,
        flow: "standard",
      });

      const transactionData = response.data;
      log(`[***] Exchange transaction ID: ${transactionData.id}`, Colors.MAGENTA);
      log(`[***] Exchange temporal address: ${transactionData.payinAddress}`, Colors.MAGENTA);

      const transaction = await EtheriumWalletService.sendCoins(transactionData.payinAddress, minimalAmount);

      if (transaction) {
        log(`[***] Exchange transaction hash: ${transaction.hash}`, Colors.MAGENTA);
      }

      return {
        exchangeAPIresponse: transactionData,
        ethTransaction: transaction,
      };
    } catch (error) {
      log("Error changing ETH to BNB", Colors.RED);
      log(error, Colors.RED);
    }
  };
}

export default new CryptoExchangeService();

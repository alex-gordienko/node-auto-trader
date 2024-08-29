import axios from "axios";
import cryptoConfig from "../config/crypto.config";
import { log, Colors } from "../utils/colored-console";
import MoneroWalletService from "./PolygonWallet.service";
import EtheriumWalletService from "./EtheriumWallet.service";
import { CryptoExchangeCoins, CryptoExchangePairs } from "../types/basic.types";

class CryptoExchangeService {
  private readonly changeNOW_base_url: string = "https://api.changenow.io/v1";
  private readonly POLY_wallet: string = cryptoConfig.polygonWallet;
  private readonly ETH_wallet: string = cryptoConfig.etheriumWallet;
  private readonly changeNOW_api_key: string = cryptoConfig.changeNowApiKey;

  constructor() {
    log("[*] Initializing Crypto Exchange Service", Colors.MAGENTA);
    this.getAvailableTradePairs();
    this.minimalExchangeAmount(CryptoExchangeCoins.POLY, CryptoExchangeCoins.ETH);
    this.minimalExchangeAmount(CryptoExchangeCoins.ETH, CryptoExchangeCoins.POLY);
  }

  public getAvailableTradePairs = async (): Promise<boolean> => {
    try {
      const response = await axios.get(`${this.changeNOW_base_url}/market-info/available-pairs`, {
        headers: {
          "x-api-key": this.changeNOW_api_key,
        },
      });

      const trxCurrencies = response.data.filter(
        (pair: string) => pair.includes(CryptoExchangeCoins.POLY) && pair.includes(CryptoExchangeCoins.ETH)
      );

      log(`[**] Available trade pairs: ${trxCurrencies.join(", ")}`, Colors.MAGENTA);

      const isPOLYETHAvailable = response.data.find((pair: string) => pair === CryptoExchangePairs.POLY_ETH);

      const isETHPOLYAvailable = response.data.find((pair: string) => pair === CryptoExchangePairs.ETH_POLY);

      if (!isPOLYETHAvailable) {
        log("POLY-ETH pair is not available", Colors.RED);
        return false;
      }

      if (!isETHPOLYAvailable) {
        log("ETH-POLY pair is not available", Colors.RED);
        return false;
      }

      log("[**] POLY-ETH and ETH-POLY tradings are available", Colors.MAGENTA);
      return true;
    } catch (error) {
      log("Error getting available trade pairs", Colors.RED);
      log(error, Colors.RED);
      return false;
    }
  };

  public minimalExchangeAmount = async (from: CryptoExchangeCoins, to: CryptoExchangeCoins): Promise<number> => {
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

  public changePOLYtoETH = async () => {
    log(`[**] Changing POLY to ETH`, Colors.MAGENTA);
    try {
      const isPOLY_ETHAvailable = await this.getAvailableTradePairs();
      const minimalAmount = await this.minimalExchangeAmount(CryptoExchangeCoins.POLY, CryptoExchangeCoins.ETH);

      if (!isPOLY_ETHAvailable || minimalAmount === 0) {
        log("[***] POLY-ETH pair is not available or minimal amount is 0", Colors.RED);
        return;
      }

      const response = await axios.post(`${this.changeNOW_base_url}/transactions/${this.changeNOW_api_key}`, {
        from: CryptoExchangeCoins.POLY,
        to: CryptoExchangeCoins.ETH,
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
      log("Error changing POLY to ETH", Colors.RED);
      log(error, Colors.RED);
    }
  };

  public changeETHtoPOLY = async () => {
    log(`[**] Changing ETH to POLY`, Colors.MAGENTA);
    try {
      const isETH_POLYavailable = await this.getAvailableTradePairs();
      const minimalAmount = await this.minimalExchangeAmount(CryptoExchangeCoins.ETH, CryptoExchangeCoins.POLY);

      if (!isETH_POLYavailable || minimalAmount === 0) {
        log("[***] ETH-POLY pair is not available or minimal amount is 0", Colors.RED);
        return;
      }

      const response = await axios.post(`${this.changeNOW_base_url}/transactions/${this.changeNOW_api_key}`, {
        from: CryptoExchangeCoins.ETH,
        to: CryptoExchangeCoins.POLY,
        amount: minimalAmount,
        address: this.POLY_wallet,
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
      log("Error changing ETH to POLY", Colors.RED);
      log(error, Colors.RED);
    }
  };
}

export default new CryptoExchangeService();

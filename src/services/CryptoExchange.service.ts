import axios from "axios";
import cryptoConfig from "../config/crypto.config";
import { log, Colors } from "../utils/colored-console";
import WavesWalletService from "./WavesWallet.service";
import EtheriumWalletService from "./EtheriumWallet.service";
import { CryptoExchangeCoins, CryptoExchangePairs } from "../types/basic.types";
import { TransactionResponse } from "ethers";
import { TransferTransaction } from "@waves/ts-types";
import { WithId, WithProofs } from "@waves/waves-transactions";
import { ICryptoExchangeResponse } from "../types/cryptoExchange.types";


class CryptoExchangeService {
  private readonly changeNOW_base_url: string = "https://api.changenow.io/v1";
  private readonly WAVES_wallet: string = cryptoConfig.wavesWallet;
  private readonly ETH_wallet: string = cryptoConfig.etheriumWallet;
  private readonly changeNOW_api_key: string = cryptoConfig.changeNowApiKey;

  constructor() {
    log("[*] Initializing Crypto Exchange Service", Colors.MAGENTA);
    this.getAvailableTradePairs();
    this.minimalExchangeAmount(CryptoExchangeCoins.WAVES, CryptoExchangeCoins.ETH);
    this.minimalExchangeAmount(CryptoExchangeCoins.ETH, CryptoExchangeCoins.WAVES);
  }

  public getAvailableTradePairs = async (): Promise<boolean> => {
    try {
      const response = await axios.get(`${this.changeNOW_base_url}/market-info/available-pairs`, {
        headers: {
          "x-api-key": this.changeNOW_api_key,
        },
      });

      const trxCurrencies = response.data.filter(
        (pair: string) => pair.includes(CryptoExchangeCoins.WAVES) && pair.includes(CryptoExchangeCoins.ETH)
      );

      log(`[**] Available trade pairs: ${trxCurrencies.join(", ")}`, Colors.MAGENTA);

      const isWAVESETHAvailable = response.data.find((pair: string) => pair === CryptoExchangePairs.WAVES_ETH);

      const isETHWAVESAvailable = response.data.find((pair: string) => pair === CryptoExchangePairs.ETH_WAVES);

      if (!isWAVESETHAvailable) {
        log("WAVES-ETH pair is not available", Colors.RED);
        return false;
      }

      if (!isETHWAVESAvailable) {
        log("ETH-WAVES pair is not available", Colors.RED);
        return false;
      }

      log("[**] WAVES-ETH and ETH-WAVES tradings are available", Colors.MAGENTA);
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

  public changeWAVEStoETH = async (): Promise<{
    exchangeAPIresponse: ICryptoExchangeResponse;
    wavesTransaction: (TransferTransaction & WithId & WithProofs) | null;
  } | null> => {
    log(`[**] Changing WAVES to ETH`, Colors.MAGENTA);
    try {
      const isWAVES_ETHAvailable = await this.getAvailableTradePairs();
      const minimalAmount = await this.minimalExchangeAmount(CryptoExchangeCoins.WAVES, CryptoExchangeCoins.ETH);

      if (!isWAVES_ETHAvailable || minimalAmount === 0) {
        log("[***] WAVES-ETH pair is not available or minimal amount is 0", Colors.RED);
        return null;
      }

      const response = await axios.post(`${this.changeNOW_base_url}/transactions/${this.changeNOW_api_key}`, {
        from: CryptoExchangeCoins.WAVES,
        to: CryptoExchangeCoins.ETH,
        amount: minimalAmount,
        address: this.ETH_wallet,
        flow: "standard",
      });

      const transactionData = response.data as ICryptoExchangeResponse;
      log(`[***] Exchange transaction ID: ${transactionData.id}`, Colors.MAGENTA);
      log(`[***] Exchange temporal address: ${transactionData.payinAddress}`, Colors.MAGENTA);

      const transaction = await WavesWalletService.sendCoins(transactionData.payinAddress, minimalAmount);

      if (transaction) {
        log(`[***] Exchange transaction hash: ${transaction.id}`, Colors.MAGENTA);
      }

      return {
        exchangeAPIresponse: transactionData,
        wavesTransaction: transaction,
      };
    } catch (error) {
      log("Error changing WAVES to ETH", Colors.RED);
      log(error, Colors.RED);
      return null;
    }
  };

  public changeETHtoWAVES = async (): Promise<{
    exchangeAPIresponse: ICryptoExchangeResponse;
    ethTransaction: TransactionResponse | null;
  } | null> => {
    log(`[**] Changing ETH to WAVES`, Colors.MAGENTA);
    try {
      const isETH_WAVESavailable = await this.getAvailableTradePairs();
      const minimalAmount = await this.minimalExchangeAmount(CryptoExchangeCoins.ETH, CryptoExchangeCoins.WAVES);

      if (!isETH_WAVESavailable || minimalAmount === 0) {
        log("[***] ETH-WAVES pair is not available or minimal amount is 0", Colors.RED);
        return null;
      }

      const response = await axios.post(`${this.changeNOW_base_url}/transactions/${this.changeNOW_api_key}`, {
        from: CryptoExchangeCoins.ETH,
        to: CryptoExchangeCoins.WAVES,
        amount: minimalAmount,
        address: this.WAVES_wallet,
        flow: "standard",
      });

      const transactionData = response.data as ICryptoExchangeResponse;
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
      log("Error changing ETH to WAVES", Colors.RED);
      log(error, Colors.RED);
      return null;
    }
  };
}

export default new CryptoExchangeService();

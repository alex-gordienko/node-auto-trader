import axios, { AxiosError } from "axios";
import cryptoConfig from "../config/crypto.config";
import { log, Colors } from "../utils/colored-console";
import WavesWalletService from "./WavesWallet.service";
import EtheriumWalletService from "./EtheriumWallet.service";
import { CryptoBase, CryptoExchangeCoins } from "../types/basic.types";
import { TransactionResponse } from "ethers";
import { TransferTransaction } from "@waves/ts-types";
import { WithId, WithProofs } from "@waves/waves-transactions";
import { ICryptoExchangeSwapResponse, ICryptoExchangePossiblePairsResponse } from "../types/cryptoExchange.types";

class CryptoExchangeService {
  private readonly changeNOW_base_url: string = "https://api.changenow.io/v2";

  // read per call so importing this module needs neither the API key nor the wallet address
  private get ETH_wallet(): string {
    return cryptoConfig.etheriumWallet;
  }

  private get changeNOW_api_key(): string {
    return cryptoConfig.changeNowApiKey;
  }

  constructor() {
    // No pair discovery here: it was an HTTP call on import. `swapCoins` checks availability before every swap.
    log("[*] Initializing Crypto Exchange Service", Colors.MAGENTA);
  }

  public getAvailableTradePairs = async (): Promise<boolean> => {
    try {
      const response = await axios.get<ICryptoExchangePossiblePairsResponse[]>(`${this.changeNOW_base_url}/exchange/available-pairs`, {
        headers: {
          "x-changenow-api-key": this.changeNOW_api_key,
        },
      });

      const availableCoins: CryptoExchangeCoins[] = [];
      const unavailableCoins: CryptoExchangeCoins[] = [];
      for (const cryptoExchangePair of Object.values(CryptoExchangeCoins)) {
        const from = cryptoExchangePair.split("_")[0].toLowerCase() as CryptoBase;
        const to = cryptoExchangePair.split("_")[1].toLowerCase() as CryptoBase;

        const isAvailable = response.data.find(pair => pair.fromCurrency === from && pair.toCurrency === to && pair.fromNetwork === "eth" && pair.toNetwork === "eth") !== undefined;
        if (!isAvailable) {
          unavailableCoins.push(cryptoExchangePair);
        } else {
          availableCoins.push(cryptoExchangePair);

          await this.minimalExchangeAmount(from, to);
          await this.minimalExchangeAmount(to, from);
        }
      }

      availableCoins.length && log(`[**] ${availableCoins.join(", ")} tradings are available`, Colors.MAGENTA);
      unavailableCoins.length && log(`[**] ${unavailableCoins.join(", ")} tradings are unavailable`, Colors.RED);
      return true;
    } catch (error) {
      log("Error getting available trade pairs", Colors.RED);
      log((error as AxiosError).response?.data, Colors.RED);
      return false;
    }
  };

  public minimalExchangeAmount = async (from: CryptoBase, to: CryptoBase): Promise<number> => {
    try {
      const response = await axios.get(`${this.changeNOW_base_url}/exchange/min-amount?fromCurrency=${from}&toCurrency=${to}&fromNetwork=eth&toNetwork=eth`, {
        headers: {
          "x-changenow-api-key": this.changeNOW_api_key,
        },
      });

      const minimalAmount = response.data.minAmount;
      log(`[**] Minimal exchange amount for ${from}-${to} pair is ${minimalAmount}`, Colors.MAGENTA);
      return minimalAmount as number;
    } catch (error) {
      log(`Error getting minimal exchange amount for ${from}-${to}`, Colors.RED);
      log((error as AxiosError).response?.data, Colors.RED);
      return 0;
    }
  };

  public swapCoins = async (from: CryptoBase, to: CryptoBase): Promise<{
    exchangeAPIresponse: ICryptoExchangeSwapResponse;
    ethTransaction: TransactionResponse | null;
  } | null> => {
    if (from === to) {
      log(`[***] ${from} and ${to} are the same coins. No need to swap`, Colors.YELLOW);
      return null;
    }
    log(`[**] Changing ${from} to ${to}`, Colors.MAGENTA);
    try {
      const isTradeAvailable = await this.getAvailableTradePairs();
      const minimalAmount = await this.minimalExchangeAmount(from, to);

      if (!isTradeAvailable || minimalAmount === 0) {
        log(`[***] ${from}-${to} pair is not available or minimal amount is 0`, Colors.RED);
        return null;
      }

      const response = await axios.post(`${this.changeNOW_base_url}/exchange`, {
        fromCurrency: from,
        toCurrency: to,
        fromNetwork: "eth",
        toNetwork: "eth",
        amount: minimalAmount,
        address: this.ETH_wallet,
        flow: "standard",
      }, {
        headers: {
          "x-changenow-api-key": this.changeNOW_api_key,
        },
      });

      const transactionData = response.data as ICryptoExchangeSwapResponse;
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
      log(`Error changing ${from} to ${to}`, Colors.RED);
      log(error, Colors.RED);
      return null;
    }
  };
}

export default new CryptoExchangeService();

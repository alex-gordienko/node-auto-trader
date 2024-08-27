import axios from "axios";
import cryptoConfig from "../config/crypto.config";
import { log, Colors } from "../utils/colored-console";
import MoneroWalletService from "./MoneroWallet.service";
import EtheriumWalletService from "./EtheriumWallet.service";

class CryptoExchangeService {
  private readonly changeNOW_base_url: string = "https://api.changenow.io/v1";
  private readonly XMR_wallet: string =
    "46fZFvyicjt8vmsgrr7Sjt9yTuwim6BzHCTMHRS5CV9kZpj2aJ7Z3oSfMSGGX4FMgabDutDakJcmCKm9FzwRzwui2msCuAm";
  private readonly ETH_wallet: string =
    "0x1d2d00D7A74036fcd3FcbB3E030A2be2077eEfBa";
  private readonly changeNOW_api_key: string = cryptoConfig.changeNowApiKey;

  constructor() {
    log("[*] Initializing Crypto Exchange Service", Colors.MAGENTA);
    this.getAvailableTradePairs();
    this.minimalExchangeAmount("xmr", "eth");
    this.minimalExchangeAmount("eth", "xmr");
  }

  public getAvailableTradePairs = async () => {
    try {
      const response = await axios.get(
        `${this.changeNOW_base_url}/market-info/available-pairs`,
        {
          headers: {
            "x-api-key": this.changeNOW_api_key,
          },
        }
      );
      const isXMRETHAvailable = response.data.find(
        (pair: string) => pair === "xmr_eth"
      );

      const isETHXMRAvailable = response.data.find(
        (pair: string) => pair === "eth_xmr"
      );

      if (!isXMRETHAvailable) {
        log("XMR-ETH pair is not available", Colors.RED);
        return false;
      }

      if (!isETHXMRAvailable) {
        log("ETH-XMR pair is not available", Colors.RED);
        return false;
      }

      log("[**] XMR-ETH and ETH-XMR tradings are available", Colors.MAGENTA);
      return true;
    } catch (error) {
      log("Error getting available trade pairs", Colors.RED);
      log(error, Colors.RED);
    }
  };

  public minimalExchangeAmount = async (
    from: string,
    to: string
  ): Promise<number> => {
    try {
      const response = await axios.get(
        `${this.changeNOW_base_url}/min-amount/${from}_${to}`,
        {
          headers: {
            "x-api-key": this.changeNOW_api_key,
          },
        }
      );

      const minimalAmount = response.data.minAmount;
      log(
        `[**] Minimal exchange amount for ${from}-${to} pair is ${minimalAmount}`,
        Colors.MAGENTA
      );
      return minimalAmount as number;
    } catch (error) {
      log("Error getting minimal exchange amount", Colors.RED);
      log(error, Colors.RED);
      return 0;
    }
  };

  public changeXMRtoETH = async () => {
    log(`[**] Changing XMR to ETH`, Colors.MAGENTA);
    try {
      const isXMR_ETHAvailable = await this.getAvailableTradePairs();
      const minimalAmount = await this.minimalExchangeAmount("xmr", "eth");

      if (!isXMR_ETHAvailable || minimalAmount === 0) {
        log(
          "[***] XMR-ETH pair is not available or minimal amount is 0",
          Colors.RED
        );
        return;
      }

      const response = await axios.post(
        `${this.changeNOW_base_url}/transactions/${this.changeNOW_api_key}`,
        {
          from: "xmr",
          to: "eth",
          amount: minimalAmount,
          address: this.ETH_wallet,
          flow: "standard",
        }
      );

      const transactionData = response.data;
      log(
        `[***] Exchange transaction ID: ${transactionData.id}`,
        Colors.MAGENTA
      );
      log(
        `[***] Exchange temporal address: ${transactionData.payinAddress}`,
        Colors.MAGENTA
      );

      const transaction = await MoneroWalletService.sendCoins(
        transactionData.payinAddress,
        minimalAmount
      );

      if (transaction) {
        log(
          `[***] Exchange transaction hash: ${transaction.hash}`,
          Colors.MAGENTA
        );
      }

      return {
        exchangeAPIresponse: transactionData,
        moneroTransaction: transaction,
      };
    } catch (error) {
      log("Error changing XMR to ETH", Colors.RED);
      log(error, Colors.RED);
    }
  };

  public changeETHtoXMR = async () => {
    log(`[**] Changing ETH to XMR`, Colors.MAGENTA);
    try {
      const isETH_XMRavailable = await this.getAvailableTradePairs();
      const minimalAmount = await this.minimalExchangeAmount("eth", "xmr");

      if (!isETH_XMRavailable || minimalAmount === 0) {
        log(
          "[***] ETH-XMR pair is not available or minimal amount is 0",
          Colors.RED
        );
        return;
      }

      const response = await axios.post(
        `${this.changeNOW_base_url}/transactions/${this.changeNOW_api_key}`,
        {
          from: "eth",
          to: "xmr",
          amount: minimalAmount,
          address: this.XMR_wallet,
          flow: "standard",
        }
      );

      const transactionData = response.data;
      log(
        `[***] Exchange transaction ID: ${transactionData.id}`,
        Colors.MAGENTA
      );
      log(
        `[***] Exchange temporal address: ${transactionData.payinAddress}`,
        Colors.MAGENTA
      );

      const transaction = await EtheriumWalletService.sendCoins(
        transactionData.payinAddress,
        minimalAmount
      );

      if (transaction) {
        log(
          `[***] Exchange transaction hash: ${transaction.hash}`,
          Colors.MAGENTA
        );
      }

      return {
        exchangeAPIresponse: transactionData,
        ethTransaction: transaction,
      };
    } catch (error) {
      log("Error changing ETH to XMR", Colors.RED);
      log(error, Colors.RED);
    }
  };
}

export default new CryptoExchangeService();

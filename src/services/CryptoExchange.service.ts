import axios from "axios";
import cryptoConfig from "../config/crypto.config";
import { log, Colors } from "../utils/colored-console";


class CryptoExchangeService {
  private readonly XMR_wallet: string =
    "428jxrCmtNsEpbbmdik9DRjgcCaqeb6Y33fAgnEgddPV5oCzm6fmkjy82SGKgRvqi8cSSH1GDyY2UUq8wVwUDQPEUUgeppY";
  private readonly USDT_wallet: string =
    "0x1d2d00D7A74036fcd3FcbB3E030A2be2077eEfBa";
  private readonly ETH_wallet: string =
    "0x1d2d00D7A74036fcd3FcbB3E030A2be2077eEfBa";
  private readonly changeNOW_api_key: string = cryptoConfig.changeNowApiKey;

  constructor() {
    log("[*] Initializing Crypto Exchange Service", Colors.MAGENTA);
  }

  public exchangeXmrToUsdt = async (amount: number) => {
    const response = await axios.post(
      "https://changenow.io/api/v1/transactions",
      {
        from: "xmr",
        to: "eth",
        amount: amount,
        fromAddress: this.XMR_wallet,
        toAddress: this.ETH_wallet,
      },
      {
        headers: {
          "x-api-key": this.changeNOW_api_key,
        },
      }
    );

    const transactionData = response.data;
    console.log("Exchange transaction ID:", transactionData.id);
    return transactionData;
  };

  public exchangeUsdtToXmr = async (amount: number) => {
    const response = await axios.post(
      "https://changenow.io/api/v1/transactions",
      {
        from: "eth",
        to: "xmr",
        amount: amount,
        fromAddress: this.ETH_wallet,
        toAddress: this.XMR_wallet,
      },
      {
        headers: {
          "x-api-key": this.changeNOW_api_key,
        },
      }
    );

    const transactionData = response.data;
    log(`Exchange transaction ID: ${transactionData.id}`, Colors.MAGENTA);
    return transactionData;
  };
}

export default new CryptoExchangeService();
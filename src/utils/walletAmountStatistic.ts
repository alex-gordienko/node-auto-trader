import { ICryproExchangeWalletHistory } from "../types/cryptoExchange.types";
import { log, Colors } from "./colored-console";

export const walletAmountStatistic = (
  coin: "ETH" | "XMR",
  currentAmount: number,
  walletHistory: ICryproExchangeWalletHistory[]
): {statusFromLastTransaction: string, statusFromBeginning: string} => {
  let message = `You have ${currentAmount} ${coin} in your wallet. `;
  let message2 = `You have ${currentAmount} ${coin} in your wallet. `;
  if (walletHistory.length === 0) {
    message += "No history found";
    message2 = "No history found";
    log(message, Colors.YELLOW);
    return {statusFromLastTransaction: message, statusFromBeginning: message2 };
  }

  const lastAmount = walletHistory[walletHistory.length - 1].amount;
  const firstAmount = walletHistory[0].amount;
  const diff = currentAmount - lastAmount;
  const diffSinceStart = currentAmount - firstAmount;
  if (diff > 0) {
    message += `You have gained ${diff} coins since your last transaction`;
    log(message, Colors.GREEN);
  } else if (diff < 0) {
    message += `You have lost ${Math.abs(
      diff
    )} coins since your last transaction`;
    log(message, Colors.RED);
  } else {
    message += `You have the same amount of coins as your last transaction`;
    log(message, Colors.YELLOW);
  }

  if (diffSinceStart > 0) {
    message2 += `You have gained ${diffSinceStart} coins since the beginning`;
    log(message2, Colors.GREEN);
  } else if (diffSinceStart < 0) {
    message2 += `You have lost ${Math.abs(
      diffSinceStart
    )} coins since the beginning`;
    log(message2, Colors.RED);
  } else {
    message2 += `You have the same amount of coins as the beginning`;
    log(message2, Colors.YELLOW);
  }

  return {statusFromLastTransaction: message, statusFromBeginning: message2 };
};

import { ICryproExchangeWalletHistory } from "../types/cryptoExchange.types";
import { log, Colors } from "./colored-console";

export const walletAmountStatistic = (
  coin: "ETH" | "XMR" | "BNB",
  currentAmount: number,
  walletHistory: ICryproExchangeWalletHistory[]
): { statusFromLastTransaction: string } => {
  let message = Colors.GREEN + `You have ${currentAmount} ${coin} in your wallet. `;
  if (walletHistory.length === 0) {
    message += Colors.RED + "No history found";
    return { statusFromLastTransaction: message };
  }

  const lastAmount = walletHistory[walletHistory.length - 1].amount;
  const firstAmount = walletHistory[0].amount;
  const diff = currentAmount - lastAmount;
  const diffSinceStart = currentAmount - firstAmount;
  if (diff > 0) {
    message += Colors.GREEN + `(+ ${diff}) since last transaction. `;
  } else if (diff < 0) {
    message += Colors.RED + `(- ${Math.abs(diff)}) since last transaction. `;
  } else {
    message += Colors.YELLOW + ` (0) since last transaction. `;
  }

  if (diffSinceStart > 0) {
    message += Colors.GREEN + `(+ ${diffSinceStart}) since beginning. `;
  } else if (diffSinceStart < 0) {
    message += Colors.RED + `(- ${Math.abs(diffSinceStart)}) since the beginning. `;
  } else {
    message += Colors.YELLOW + `(0) since beginning. `;
  }

  log(message);

  return { statusFromLastTransaction: message };
};

import dotenv from "dotenv";
dotenv.config();

const cryptoConfig = {
  // api-keys
  cryptoCompareApiKey: process.env.CRYPTO_COMPARE_API_KEY || "YOUR_API_KEY",
  changeNowApiKey: process.env.CHANGE_NOW_API || "YOUR_API_KEY",

  // providers api-keys
  infuraApiKey: process.env.INFURA_API_KEY || "YOUR_API_KEY",
  blockCypherApiKey: process.env.BLOCK_CYPHER_API || "YOUR_API",

  // wallet keys
  etheriumPrivateKey: process.env.ETHERIUM_PRIVATE_KEY || "YOUR_PRIVATE",
  bitcoinPrivateKey: process.env.BITCOIN_PRIVATE_KEY || "YOUR_PRIVATE",

  requestLimitMinutePair: process.env.REQUEST_LIMIT || 10,
};

export default cryptoConfig;

import crypto from "crypto";

import cryptoConfig from "../../../config/crypto.config";

/**
 * The only module that touches Binance signing key material (TRA-16 plan §2.3). Ed25519, not HMAC: the key held
 * is an asymmetric private key, not a bearer secret that is itself sufficient to trade if it leaks from a log or
 * a header dump. Never logs its input or output and never returns the key.
 */
class BinanceSigner {
  public sign(canonicalQueryString: string): string {
    const privateKey = crypto.createPrivateKey(cryptoConfig.binance.ed25519PrivateKeyPem);
    return crypto.sign(null, Buffer.from(canonicalQueryString), privateKey).toString("base64");
  }
}

export default new BinanceSigner();

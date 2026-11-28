import type { Translations } from "../words"

/**
 * The translations of the words of `web3_solana_send`'s prompt that the EVM sends do not draw: fact labels and value
 * templates, each keyed by the English text the code writes. The words the two share (the title, the headlines and
 * most labels) are in `EVM_TRANSLATIONS`. A translated template holds the placeholders of the English one.
 */
export const SOLANA_TRANSLATIONS: Translations = {
  ja: {
    "Token account": "トークンアカウント",
    "Permanent delegate": "永続的なデリゲート",

    "{amount} {symbol} ({units} lamports)": "{amount} {symbol}（{units} lamports）",
    "created for the recipient, rent {rent} lamports": "受取人のために作成（レント {rent} lamports）",
    "{address}, which can move any holder's tokens": "{address}（あらゆる保有者のトークンを動かせます）",
    "{lamports} lamports ({amount} {symbol})": "{lamports} lamports（{amount} {symbol}）",
  },
}

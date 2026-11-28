import type { Translations } from "../words"

/**
 * The translations of the words of `web3_solana_send`'s and `web3_solana_revoke`'s prompts that the EVM tools do not
 * draw: headline templates, fact labels and value templates, each keyed by the English text the code writes. The words
 * the two share (the titles, intents and most labels) are in `EVM_TRANSLATIONS`. A translated template holds the
 * placeholders of the English one.
 */
export const SOLANA_TRANSLATIONS: Translations = {
  ja: {
    "Send NFT {mint} on {chain}": "{chain} で NFT {mint} を送金",
    "Revoke {delegate}'s approval to move {mint} on {chain}": "{chain} で {mint} を動かす {delegate} の承認を取り消し",

    NFT: "NFT",
    "Token account": "トークンアカウント",
    "Permanent delegate": "永続的なデリゲート",
    Delegate: "デリゲート",

    "{amount} {symbol} ({units} lamports)": "{amount} {symbol}（{units} lamports）",
    "created for the recipient, rent {rent} lamports": "受取人のために作成（レント {rent} lamports）",
    "{address}, which can move any holder's tokens": "{address}（あらゆる保有者のトークンを動かせます）",
    "{lamports} lamports ({amount} {symbol})": "{lamports} lamports（{amount} {symbol}）",
    "the delegate's approval": "デリゲートの承認",
  },
}

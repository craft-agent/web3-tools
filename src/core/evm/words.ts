import type { Translations } from "../words"

/**
 * The translations of the words of `web3_evm_send`'s and `web3_evm_revoke`'s prompts: titles, intents, headline
 * templates, fact labels and value templates, each keyed by the English text the code writes. A translated
 * template holds the placeholders of the English one.
 */
export const EVM_TRANSLATIONS: Translations = {
  ja: {
    "Send from a wallet": "ウォレットから送金",
    "About to send funds from a wallet": "ウォレットから資金を送金しようとしています",
    "Revoke an approval": "承認の取り消し",
    "About to revoke an approval a wallet gave": "ウォレットが与えた承認を取り消そうとしています",

    "Send {amount} {symbol} on {chain}": "{chain} で {amount} {symbol} を送金",
    "Send {amount} of a token on {chain}": "{chain} でトークン {amount} を送金",
    "Send NFT #{id} of {collection} on {chain}": "{chain} で {collection} の NFT #{id} を送金",
    "Send {count} of NFT #{id} of {collection} on {chain}": "{chain} で {collection} の NFT #{id} を {count} 個送金",
    "Revoke {spender}'s allowance of {token} on {chain}": "{chain} で {token} に対する {spender} の承認額を取り消し",
    "Revoke {spender} as operator of every NFT of {collection} on {chain}":
      "{chain} で {collection} の全 NFT に対する {spender} のオペレーター承認を取り消し",

    Recipient: "受取人",
    "ENS name": "ENS 名",
    "Own wallet": "自分のウォレット",
    Token: "トークン",
    Amount: "数量",
    Collection: "コレクション",
    "Token id": "トークン ID",
    Count: "個数",
    "Max fee": "手数料の上限",
    Spender: "承認先",
    Revokes: "取り消す内容",

    "{name} resolved to {address}": "{name} は {address} に解決されました",
    "your wallet {wallet}": "あなたのウォレット {wallet}",
    "not one of your wallets": "あなたのウォレットではありません",
    "{chain}'s native coin {symbol}": "{chain} のネイティブコイン {symbol}",
    '{address} declaring the symbol "{symbol}"': "{address}（コントラクトが名乗るシンボル「{symbol}」）",
    "{address}, whose declared symbol is not shown": "{address}（名乗っているシンボルは表示しません）",
    "{amount} {symbol} ({units} wei)": "{amount} {symbol}（{units} wei）",
    "{amount} ({units} smallest units, {decimals} decimals)": "{amount}（最小単位で {units}、小数 {decimals} 桁）",
    "{amount} {symbol} ({units} smallest units, {decimals} decimals)":
      "{amount} {symbol}（最小単位で {units}、小数 {decimals} 桁）",
    "{wei} wei ({amount} {symbol})": "{wei} wei（{amount} {symbol}）",
    "the allowance": "承認額",
    "the operator approval": "オペレーターの承認",
  },
}

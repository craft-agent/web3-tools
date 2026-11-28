import type { CallFact, CallValue } from "../tool"

/** The wallet that owns an address, as the person names it: `main`, or `main#3` for an account of a seed phrase. */
export type OwnWallet = { label: string; index: number | null }

/** How a contract is shown with the symbol it declares; a symbol is chosen by whoever deployed the contract. */
export const DECLARED_SYMBOL_TEXT = '{address} declaring the symbol "{symbol}"'

/** A contract as the person is shown it: its address, with the symbol it declares when a prompt may show it. */
export function contractValue(address: string, symbol: string | null): string | CallValue {
  return symbol === null ? address : { text: DECLARED_SYMBOL_TEXT, values: { address, symbol } }
}

/** The fact that says whether the recipient is one of the person's own wallets, and which. */
export function ownerFact(own: OwnWallet | undefined): CallFact {
  const value: CallValue = own
    ? { text: "your wallet {wallet}", values: { wallet: own.index === null ? own.label : `${own.label}#${own.index}` } }
    : { text: "not one of your wallets" }
  return { label: "Own wallet", value }
}

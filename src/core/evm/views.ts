import { addressWord, bytesArgument, word } from "./abi"
import { checkUint256 } from "./uint256"

/** The first four bytes of the Keccak-256 of each signature of a read, as 8 hex digits. */
export const VIEW_SELECTORS = {
  /** `decimals()` */
  decimals: "313ce567",
  /** `symbol()` */
  symbol: "95d89b41",
  /** `balanceOf(address)` */
  balanceOf: "70a08231",
  /** `getL1Fee(bytes)`, of the OP Stack's and Scroll's oracles */
  getL1Fee: "49948e0e",
  /** `getOperatorFee(uint256)`, of the OP Stack's oracle */
  getOperatorFee: "275aedd2",
  /** `tokenRatio()`, of Mantle's oracle */
  tokenRatio: "06f837d3",
}

/** The calldata of `decimals()`. */
export const DECIMALS_CALL = `0x${VIEW_SELECTORS.decimals}`

/** The calldata of `symbol()`. */
export const SYMBOL_CALL = `0x${VIEW_SELECTORS.symbol}`

/** The calldata of `tokenRatio()`. */
export const TOKEN_RATIO_CALL = `0x${VIEW_SELECTORS.tokenRatio}`

/** The calldata of `balanceOf(owner)`. */
export function balanceOfCall(owner: string): string {
  return `0x${VIEW_SELECTORS.balanceOf}${addressWord(owner)}`
}

/** The calldata of `getL1Fee(transaction)`, with `transaction` as the `0x` and hex bytes the oracle prices. */
export function getL1FeeCall(transaction: string): string {
  return `0x${VIEW_SELECTORS.getL1Fee}${bytesArgument(transaction)}`
}

/** The calldata of `getOperatorFee(gasLimit)`. */
export function getOperatorFeeCall(gasLimit: bigint): string {
  return `0x${VIEW_SELECTORS.getOperatorFee}${word(checkUint256(gasLimit, "gas limit"))}`
}

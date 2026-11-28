import { addressWord, bytesArgument, word, WORD_BYTES } from "./abi"
import { checkUint256 } from "./uint256"

/** What `checkUint256` calls a token id in its refusal. */
const TOKEN_ID_LABEL = "token id"

/** The first four bytes of the Keccak-256 of each signature of a read, as 8 hex digits. */
export const VIEW_SELECTORS = {
  /** `decimals()` */
  decimals: "313ce567",
  /** `symbol()` */
  symbol: "95d89b41",
  /** `balanceOf(address)` */
  balanceOf: "70a08231",
  /** `allowance(address,address)` */
  allowance: "dd62ed3e",
  /** `ownerOf(uint256)` */
  ownerOf: "6352211e",
  /** `isApprovedForAll(address,address)` */
  isApprovedForAll: "e985e9c5",
  /** `supportsInterface(bytes4)` */
  supportsInterface: "01ffc9a7",
  /** `balanceOf(address,uint256)`, of ERC-1155 */
  erc1155BalanceOf: "00fdd58e",
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

/** The calldata of `allowance(owner, spender)`. */
export function allowanceCall(owner: string, spender: string): string {
  return `0x${VIEW_SELECTORS.allowance}${addressWord(owner)}${addressWord(spender)}`
}

/** The calldata of `ownerOf(tokenId)`. */
export function ownerOfCall(tokenId: bigint): string {
  return `0x${VIEW_SELECTORS.ownerOf}${word(checkUint256(tokenId, TOKEN_ID_LABEL))}`
}

/** The calldata of `isApprovedForAll(owner, operator)`. */
export function isApprovedForAllCall(owner: string, operator: string): string {
  return `0x${VIEW_SELECTORS.isApprovedForAll}${addressWord(owner)}${addressWord(operator)}`
}

/** The calldata of `supportsInterface(interfaceId)`, with `interfaceId` as 8 hex digits: a `bytes4` fills the head of its word. */
export function supportsInterfaceCall(interfaceId: string): string {
  return `0x${VIEW_SELECTORS.supportsInterface}${interfaceId.padEnd(WORD_BYTES * 2, "0")}`
}

/** The calldata of ERC-1155's `balanceOf(owner, tokenId)`. */
export function erc1155BalanceOfCall(owner: string, tokenId: bigint): string {
  return `0x${VIEW_SELECTORS.erc1155BalanceOf}${addressWord(owner)}${word(checkUint256(tokenId, TOKEN_ID_LABEL))}`
}

/** The calldata of `getL1Fee(transaction)`, with `transaction` as the `0x` and hex bytes the oracle prices. */
export function getL1FeeCall(transaction: string): string {
  return `0x${VIEW_SELECTORS.getL1Fee}${bytesArgument(transaction)}`
}

/** The calldata of `getOperatorFee(gasLimit)`. */
export function getOperatorFeeCall(gasLimit: bigint): string {
  return `0x${VIEW_SELECTORS.getOperatorFee}${word(checkUint256(gasLimit, "gas limit"))}`
}

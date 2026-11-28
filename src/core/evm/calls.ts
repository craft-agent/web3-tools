import { parseEvmAddress } from "./address"
import { checkUint256 } from "./uint256"

/** The first four bytes of the Keccak-256 of each signature, as 8 hex digits. */
const SELECTORS = {
  /** `transfer(address,uint256)` */
  erc20Transfer: "a9059cbb",
  /** `approve(address,uint256)` */
  erc20Approve: "095ea7b3",
  /** `safeTransferFrom(address,address,uint256)` */
  erc721SafeTransferFrom: "42842e0e",
  /** `safeTransferFrom(address,address,uint256,uint256,bytes)` */
  erc1155SafeTransferFrom: "f242432a",
  /** `setApprovalForAll(address,bool)` */
  setApprovalForAll: "a22cb465",
}

/** The byte length of an ABI word, as hex digits. */
const WORD_DIGITS = 64

/** Where the `bytes` argument of ERC-1155's `safeTransferFrom` starts: after its five head words. */
const ERC1155_BYTES_OFFSET = 5n * 32n

/** An ABI word: `value` as 64 hex digits. */
function word(value: bigint): string {
  return value.toString(16).padStart(WORD_DIGITS, "0")
}

/** The ABI word of an address: its 40 digits, lower case, after 24 zeros. */
function addressWord(address: string): string {
  return parseEvmAddress(address).slice(2).toLowerCase().padStart(WORD_DIGITS, "0")
}

function call(selector: string, words: readonly string[]): string {
  return `0x${selector}${words.join("")}`
}

/** The calldata of ERC-20 `transfer(to, amount)`. */
export function erc20Transfer(to: string, amount: bigint): string {
  return call(SELECTORS.erc20Transfer, [addressWord(to), word(checkUint256(amount, "amount"))])
}

/**
 * The calldata of ERC-20 `approve(spender, amount)`. The amount stays general
 * here, but a write only ever passes 0, to revoke an allowance: none sets one.
 */
export function erc20Approve(spender: string, amount: bigint): string {
  return call(SELECTORS.erc20Approve, [addressWord(spender), word(checkUint256(amount, "amount"))])
}

/** The calldata of ERC-721 `safeTransferFrom(from, to, tokenId)`. */
export function erc721SafeTransferFrom(from: string, to: string, tokenId: bigint): string {
  return call(SELECTORS.erc721SafeTransferFrom, [
    addressWord(from),
    addressWord(to),
    word(checkUint256(tokenId, "token id")),
  ])
}

/** The calldata of ERC-1155 `safeTransferFrom(from, to, id, count, "")`, with empty `data`. */
export function erc1155SafeTransferFrom(from: string, to: string, id: bigint, count: bigint): string {
  return call(SELECTORS.erc1155SafeTransferFrom, [
    addressWord(from),
    addressWord(to),
    word(checkUint256(id, "token id")),
    word(checkUint256(count, "count")),
    word(ERC1155_BYTES_OFFSET),
    word(0n),
  ])
}

/** The calldata of `setApprovalForAll(operator, approved)`. */
export function setApprovalForAll(operator: string, approved: boolean): string {
  return call(SELECTORS.setApprovalForAll, [addressWord(operator), word(approved ? 1n : 0n)])
}

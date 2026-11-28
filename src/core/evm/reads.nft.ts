import { ToolError } from "../errors"
import type { JsonRpcClient } from "../rpc/client"
import { parseEvmAddress } from "./address"
import { bytesOfHex, readWord, WORD_BYTES } from "./abi"
import { callView, viewWord } from "./reads"
import { erc1155BalanceOfCall, ownerOfCall, supportsInterfaceCall } from "./views"

/** The ERC-165 interface ids a collection declares: ERC-721 and ERC-1155, as 8 hex digits. */
const INTERFACE_IDS = { erc721: "80ac58cd", erc1155: "d9b67a26" } as const

/** The two standards of an NFT collection, in the order they are asked for. */
export type NftStandard = keyof typeof INTERFACE_IDS

const STANDARDS = Object.keys(INTERFACE_IDS) as NftStandard[]

/** An address is the last 20 bytes of its word: 12 bytes before them. */
const ADDRESS_WORD_PADDING_DIGITS = 24

/**
 * The standard `collection` declares through `supportsInterface`, ERC-721 first; `undefined` when it declares
 * neither (a revert, an empty answer and `false` all mean no). A failed read is not a no: it propagates.
 */
export async function nftStandard(client: JsonRpcClient, collection: string): Promise<NftStandard | undefined> {
  for (const standard of STANDARDS) {
    const what = `Whether ${collection} supports ${standard}`
    if ((await viewWord(client, collection, supportsInterfaceCall(INTERFACE_IDS[standard]), what)) === 1n) {
      return standard
    }
  }
  return undefined
}

/**
 * The owner of ERC-721 token `tokenId` in checksum case; `undefined` when the collection reverts, which means the
 * token does not exist. An answer that is no address is `upstream_error`.
 */
export async function erc721Owner(
  client: JsonRpcClient,
  collection: string,
  tokenId: bigint,
): Promise<string | undefined> {
  const answer = await callView(client, collection, ownerOfCall(tokenId))
  if (answer.reverted) return undefined
  const bytes = bytesOfHex(answer.data)
  if (!bytes || bytes.length < WORD_BYTES) {
    throw new ToolError("upstream_error", `The owner of #${tokenId} at ${collection} could not be read; try again.`)
  }
  return parseEvmAddress(
    `0x${readWord(bytes, 0)
      .toString(16)
      .padStart(WORD_BYTES * 2, "0")
      .slice(ADDRESS_WORD_PADDING_DIGITS)}`,
  )
}

/** The ERC-1155 balance of `owner` in token `tokenId`; 0 for a collection that reverts or answers nothing. */
export async function erc1155Balance(
  client: JsonRpcClient,
  collection: string,
  owner: string,
  tokenId: bigint,
): Promise<bigint> {
  return viewWord(
    client,
    collection,
    erc1155BalanceOfCall(owner, tokenId),
    `The balance of ${owner} in #${tokenId} at ${collection}`,
  )
}

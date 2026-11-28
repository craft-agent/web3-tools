import { parseUnits } from "../amount"
import { ToolError } from "../errors"
import type { JsonRpcClient } from "../rpc/client"
import { erc1155Balance, erc721Owner, nftStandard, type NftStandard } from "./reads.nft"
import { declaredSymbol, hasCode, promptSymbol } from "./reads"
import { MAX_UINT256 } from "./uint256"

/** A token id: decimal digits without leading zeros (at most the 78 of 2^256 - 1), or `0x` and 1 to 64 hex digits. */
const TOKEN_ID_PATTERN = /^(?:0|[1-9]\d{0,77}|0x[0-9a-fA-F]{1,64})$/

/** What a collection is: its standard, and the symbol it declares when a prompt may show it. */
export type NftFacts = { standard: NftStandard; symbol: string | null }

/** What the check of an NFT send's holdings needs: the standard, the collection, who must hold the NFT, which one and how many. */
export type NftHolding = {
  kind: NftStandard
  collection: string
  owner: string
  tokenId: bigint
  count: bigint
  chainName: string
}

function refusal(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** The token id of `text`, decimal or `0x` hex, from 0 to 2^256 - 1; anything else is `invalid_argument`. */
export function parseTokenId(text: string): bigint {
  const id = typeof text === "string" && TOKEN_ID_PATTERN.test(text) ? BigInt(text) : undefined
  if (id === undefined || id > MAX_UINT256) {
    throw refusal("The token_id must be decimal digits or 0x and hex digits, a whole number from 0 to 2^256 - 1.")
  }
  return id
}

/** How many of an NFT to send, from `text`: a whole number of digits, 1 or more. */
export function parseCount(text: string): bigint {
  const count = parseUnits(text, "amount")
  if (count === 0n) throw refusal("The amount of an NFT is how many to send, a whole number of 1 or more.")
  return count
}

/**
 * The standard and the symbol of the collection at `collection`. No code there is `invalid_argument`, and so is a
 * contract that declares neither ERC-721 nor ERC-1155; a read that fails is `upstream_error`, never "neither".
 */
export async function nftFacts(client: JsonRpcClient, collection: string): Promise<NftFacts> {
  if (!(await hasCode(client, collection))) {
    throw refusal(`There is no contract at ${collection} on ${client.name}.`)
  }
  const standard = await nftStandard(client, collection)
  if (standard === undefined) {
    throw refusal(`The contract at ${collection} on ${client.name} is neither an ERC-721 nor an ERC-1155 collection.`)
  }
  return { standard, symbol: promptSymbol(await declaredSymbol(client, collection)) }
}

/**
 * Refuses, as `invalid_argument`, an NFT send the wallet cannot make: an ERC-721 token that does not exist or
 * belongs to another account, or an ERC-1155 balance below the count.
 */
export async function checkNftHeld(client: JsonRpcClient, held: NftHolding): Promise<void> {
  const { kind, collection, owner, tokenId, count, chainName } = held
  if (kind === "erc721") {
    const current = await erc721Owner(client, collection, tokenId)
    if (current === undefined) {
      throw refusal(`The NFT #${tokenId} does not exist in ${collection} on ${chainName}.`)
    }
    if (current.toLowerCase() !== owner.toLowerCase()) {
      throw refusal(`${owner} does not own the NFT #${tokenId} of ${collection} on ${chainName}; ${current} does.`)
    }
    return
  }
  const balance = await erc1155Balance(client, collection, owner, tokenId)
  if (balance < count) {
    throw refusal(
      `${owner} holds ${balance} of the NFT #${tokenId} of ${collection} on ${chainName}, less than the ${count} to send. Send a smaller count.`,
    )
  }
}

import type { JsonRpcClient } from "../rpc/client"
import { bytesOfHex, readWord, WORD_BYTES } from "./abi"
import { callView, MAX_TOKEN_DECIMALS, viewWord } from "./reads"
import { allowanceCall, DECIMALS_CALL, isApprovedForAllCall } from "./views"

/**
 * Whether `token` answers `decimals()` as an ERC-20 does: a word of at most 36. A revert, an empty or short
 * answer and a larger word all mean no; a failed read is not a no: it propagates.
 */
export async function declaresDecimals(client: JsonRpcClient, token: string): Promise<boolean> {
  const answer = await callView(client, token, DECIMALS_CALL)
  if (answer.reverted) return false
  const bytes = bytesOfHex(answer.data)
  return bytes !== undefined && bytes.length >= WORD_BYTES && readWord(bytes, 0) <= MAX_TOKEN_DECIMALS
}

/** What `spender` may still spend of `owner`'s ERC-20 tokens; 0 for a token that reverts or answers nothing. */
export async function erc20Allowance(
  client: JsonRpcClient,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  return viewWord(client, token, allowanceCall(owner, spender), `The allowance of ${spender} from ${owner} at ${token}`)
}

/** Whether `operator` may move all of `owner`'s NFTs of `collection`; false for a collection that reverts or answers nothing. */
export async function operatorApproved(
  client: JsonRpcClient,
  collection: string,
  owner: string,
  operator: string,
): Promise<boolean> {
  const what = `Whether ${operator} is an operator of ${owner} at ${collection}`
  return (await viewWord(client, collection, isApprovedForAllCall(owner, operator), what)) !== 0n
}

import type { EvmChain } from "../chains/evm"
import { ToolError } from "../errors"
import type { JsonRpcClient } from "../rpc/client"
import { isPlainObject } from "../rpc/mask"
import { parseQuantity } from "./reads"

/** The result of a transaction that landed: whether it succeeded, and its block. */
export type MinedReceipt = { status: 0 | 1; block: bigint }

/** The transaction's page on the chain's block explorer. */
export function transactionUrl(chain: EvmChain, hash: string): string {
  return `${chain.explorer}/tx/${hash}`
}

/** The refusal for a send whose sender still has a transaction the node holds without a result: `stale`, nothing was sent. */
export function stillWaiting(chain: EvmChain, hash: string): ToolError {
  return new ToolError(
    "stale",
    `The earlier send ${hash} on ${chain.name} is still waiting to land, so nothing was sent. Wait for it, and check the hash on the explorer: ${transactionUrl(chain, hash)}.`,
  )
}

function notAnswer(client: JsonRpcClient, method: string, what: string): ToolError {
  return new ToolError("upstream_error", `${client.name} answered ${method} with something that is not ${what}.`)
}

/** The receipt of the transaction `hash`; `null` while the node has none. */
export async function findReceipt(client: JsonRpcClient, hash: string): Promise<MinedReceipt | null> {
  const answer = await client.call<unknown>("eth_getTransactionReceipt", [hash])
  if (answer === null) return null
  if (!isPlainObject(answer)) throw notAnswer(client, "eth_getTransactionReceipt", "a receipt")
  const status = parseQuantity(client, answer.status, "the receipt's status")
  if (status !== 0n && status !== 1n) throw notAnswer(client, "eth_getTransactionReceipt", "a status of 0 or 1")
  return {
    status: status === 1n ? 1 : 0,
    block: parseQuantity(client, answer.blockNumber, "the receipt's blockNumber"),
  }
}

/** Whether the node knows the transaction `hash`, mined or waiting in its pool. */
export async function holdsTransaction(client: JsonRpcClient, hash: string): Promise<boolean> {
  const answer = await client.call<unknown>("eth_getTransactionByHash", [hash])
  if (answer === null) return false
  if (!isPlainObject(answer)) throw notAnswer(client, "eth_getTransactionByHash", "a transaction")
  return true
}

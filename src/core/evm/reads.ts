import { ToolError } from "../errors"
import { RpcRefusal, type JsonRpcClient } from "../rpc/client"
import { isPlainObject } from "../rpc/mask"
import { bytesOfHex, decodeAbiString, decodeUtf8, quantityHex, readWord, WORD_BYTES } from "./abi"
import { balanceOfCall, DECIMALS_CALL, SYMBOL_CALL } from "./views"

/** A call as the node simulates it: who sends it, to what, with how much value and which data. */
export type EvmCall = { from: string; to: string; value: bigint; data: string }

/** What a view call answered: its data as lower case `0x` hex, or that the contract reverted. */
export type ViewAnswer = { reverted: false; data: string } | { reverted: true }

/** The decimals and the declared symbol of an ERC-20 token. */
export type TokenFacts = { decimals: number; symbol: string | null }

/** A token has at most this many decimals; one that claims more is not taken for a token. */
export const MAX_TOKEN_DECIMALS = 36n

/** A symbol longer than this many bytes is not read. */
const MAX_SYMBOL_BYTES = 256

/** A revert reason is quoted up to this many characters. */
const MAX_REASON_CHARS = 200

/** The JSON-RPC code of a reverted call (EIP-1474 implementations). */
const REVERT_CODE = 3

/** A quantity: `0x` and hex digits without leading zeros, at most 64 of them. */
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/

const REVERT_MESSAGE = /revert/i

const UNSUPPORTED_CODE = -32601
const UNSUPPORTED_MESSAGE = /method not found|not supported|unsupported|does not exist|not available/i

/** What a prompt may show of a token's symbol. */
const PROMPT_SYMBOL = /^[A-Za-z0-9.$_-]{1,12}$/

function unreadable(client: JsonRpcClient, what: string): ToolError {
  return new ToolError("upstream_error", `${client.name} answered ${what} with something that is not a hex quantity.`)
}

/** `value` as the quantity a node answers (`0x`, no leading zeros); anything else is `upstream_error` naming the chain and `what`. */
export function parseQuantity(client: JsonRpcClient, value: unknown, what: string): bigint {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) throw unreadable(client, what)
  return BigInt(value)
}

type CallInput = Partial<Pick<EvmCall, "from" | "value">> & Pick<EvmCall, "to" | "data">

/** The call object `eth_call` and `eth_estimateGas` take. */
export function callParams(call: CallInput): Record<string, string> {
  const { from, to, value, data } = call
  return {
    ...(from === undefined ? {} : { from }),
    to,
    ...(value === undefined ? {} : { value: quantityHex(value) }),
    data,
  }
}

/** Whether `error` is the node saying a call reverts: JSON-RPC code 3, or a message that says so. */
export function isRevert(error: unknown): error is RpcRefusal {
  return error instanceof RpcRefusal && (error.rpc.code === REVERT_CODE || REVERT_MESSAGE.test(error.rpc.message))
}

function refusalOfReason(reason: string): ToolError {
  const quoted = reason === "" ? "." : `: ${JSON.stringify(reason.slice(0, MAX_REASON_CHARS))}`
  return new ToolError("invalid_argument", `The chain would revert this transaction${quoted}`)
}

/**
 * The refusal for `error` when it is the node saying a call reverts: `invalid_argument`, quoting the node's own
 * words (already masked) up to 200 characters as data. `undefined` for any other failure.
 */
export function revertRefusalOf(error: unknown): ToolError | undefined {
  return isRevert(error) ? refusalOfReason(error.rpc.message) : undefined
}

/** The balance of `address`, in the chain's smallest unit. */
export async function nativeBalance(client: JsonRpcClient, address: string): Promise<bigint> {
  return parseQuantity(client, await client.call("eth_getBalance", [address, "latest"]), "eth_getBalance")
}

/** The number of transactions `address` has sent, as of the latest block or counting those still pending. */
export async function transactionCount(
  client: JsonRpcClient,
  address: string,
  block: "latest" | "pending",
): Promise<bigint> {
  return parseQuantity(
    client,
    await client.call("eth_getTransactionCount", [address, block]),
    "eth_getTransactionCount",
  )
}

/** Whether `address` holds code. */
export async function hasCode(client: JsonRpcClient, address: string): Promise<boolean> {
  const code = bytesOfHex(await client.call("eth_getCode", [address, "latest"]))
  if (!code)
    throw new ToolError("upstream_error", `${client.name} answered eth_getCode with something that is not code.`)
  return code.length > 0
}

/** The base fee per gas of the latest block; 0 for a block without one. */
export async function latestBaseFee(client: JsonRpcClient): Promise<bigint> {
  const block = await client.call<unknown>("eth_getBlockByNumber", ["latest", false])
  if (!isPlainObject(block)) {
    throw new ToolError(
      "upstream_error",
      `${client.name} answered eth_getBlockByNumber with something that is not a block.`,
    )
  }
  const fee = block.baseFeePerGas
  return fee === undefined || fee === null ? 0n : parseQuantity(client, fee, "the block's baseFeePerGas")
}

function isUnsupported(error: unknown): boolean {
  return (
    error instanceof RpcRefusal && (error.rpc.code === UNSUPPORTED_CODE || UNSUPPORTED_MESSAGE.test(error.rpc.message))
  )
}

/**
 * The tip a transaction should offer per gas: `eth_maxPriorityFeePerGas`, or, from a node that does not have it,
 * `eth_gasPrice` less the latest base fee (0 when that is below it).
 */
export async function priorityFee(client: JsonRpcClient): Promise<bigint> {
  try {
    return parseQuantity(client, await client.call("eth_maxPriorityFeePerGas"), "eth_maxPriorityFeePerGas")
  } catch (error) {
    if (!isUnsupported(error)) throw error
  }
  const [price, base] = await Promise.all([
    client.call("eth_gasPrice").then((answer) => parseQuantity(client, answer, "eth_gasPrice")),
    latestBaseFee(client),
  ])
  return price > base ? price - base : 0n
}

type CallOutcome = { reverted: false; data: string } | { reverted: true; reason: string }

async function ethCall(client: JsonRpcClient, call: CallInput): Promise<CallOutcome> {
  try {
    const data = await client.call<unknown>("eth_call", [callParams(call), "latest"])
    if (bytesOfHex(data) === undefined) {
      throw new ToolError("upstream_error", `${client.name} answered eth_call with something that is not data.`)
    }
    return { reverted: false, data: (data as string).toLowerCase() }
  } catch (error) {
    if (isRevert(error)) return { reverted: true, reason: error.rpc.message }
    throw error
  }
}

/**
 * `eth_call` of `data` on `to` at the latest block. A revert (code 3, or a message that says so) is
 * `{ reverted: true }`; any other failure propagates.
 */
export async function callView(client: JsonRpcClient, to: string, data: string): Promise<ViewAnswer> {
  const outcome = await ethCall(client, { to, data })
  return outcome.reverted ? { reverted: true } : outcome
}

/**
 * The first 32-byte word of a view's answer. A revert or an empty answer (a contract without the function, an
 * address without code) reads as 0; an answer that is anything else but a word is `upstream_error` saying `what`
 * could not be read, so "nothing" never stands for "unread".
 */
export async function viewWord(client: JsonRpcClient, to: string, data: string, what: string): Promise<bigint> {
  const answer = await callView(client, to, data)
  if (answer.reverted) return 0n
  const bytes = bytesOfHex(answer.data) ?? new Uint8Array()
  if (bytes.length === 0) return 0n
  if (bytes.length < WORD_BYTES) throw new ToolError("upstream_error", `${what} could not be read; try again.`)
  return readWord(bytes, 0)
}

function decodeSymbol(bytes: Uint8Array): string | null {
  let text: string | undefined
  if (bytes.length === WORD_BYTES) {
    let end = bytes.length
    while (end > 0 && bytes[end - 1] === 0) end--
    text = decodeUtf8(bytes.subarray(0, end))
  } else {
    text = decodeAbiString(bytes)
  }
  return text === undefined || text === "" || new TextEncoder().encode(text).length > MAX_SYMBOL_BYTES ? null : text
}

/**
 * The decimals and declared symbol of the ERC-20 token at `token`. No code there, or `decimals()` that cannot be
 * read, reverts or is above 36, is `invalid_argument`. The symbol is decoded as an ABI string or as `bytes32`
 * (trailing zeros trimmed) and is `null` when the token has none or it cannot be decoded; it is the text the
 * token declared, chosen by whoever deployed it (`promptSymbol` says what a prompt may show).
 */
export async function tokenFacts(client: JsonRpcClient, token: string): Promise<TokenFacts> {
  if (!(await hasCode(client, token))) {
    throw new ToolError("invalid_argument", `There is no contract at ${token} on ${client.name}.`)
  }
  const decimals = await callView(client, token, DECIMALS_CALL)
  const decimalsBytes = decimals.reverted ? undefined : bytesOfHex(decimals.data)
  const decimalsWord = decimalsBytes && decimalsBytes.length >= WORD_BYTES ? readWord(decimalsBytes, 0) : undefined
  if (decimalsWord === undefined || decimalsWord > MAX_TOKEN_DECIMALS) {
    throw new ToolError(
      "invalid_argument",
      `The contract at ${token} on ${client.name} is not an ERC-20 token: its decimals() could not be read or is above ${MAX_TOKEN_DECIMALS}.`,
    )
  }
  return { decimals: Number(decimalsWord), symbol: await declaredSymbol(client, token) }
}

/**
 * The symbol the contract at `token` declares through `symbol()`, decoded as `tokenFacts` does; `null` when it
 * reverts, answers nothing or answers what cannot be decoded.
 */
export async function declaredSymbol(client: JsonRpcClient, token: string): Promise<string | null> {
  const symbol = await callView(client, token, SYMBOL_CALL)
  const symbolBytes = symbol.reverted ? undefined : bytesOfHex(symbol.data)
  return symbolBytes ? decodeSymbol(symbolBytes) : null
}

/** `symbol` when a prompt may show it (1 to 12 letters, digits and `.$_-`), else `null`: a symbol is stranger-chosen text. */
export function promptSymbol(symbol: string | null): string | null {
  return symbol !== null && PROMPT_SYMBOL.test(symbol) ? symbol : null
}

/** The ERC-20 balance of `owner` at `token`; 0 for a token that reverts or answers nothing. */
export async function erc20Balance(client: JsonRpcClient, token: string, owner: string): Promise<bigint> {
  return viewWord(client, token, balanceOfCall(owner), `The balance of ${owner} at ${token}`)
}

/**
 * The gas the node estimates for `call`. A revert is `invalid_argument`: "The chain would revert this
 * transaction" and the node's reason, quoted as data.
 */
export async function estimateGas(client: JsonRpcClient, call: EvmCall): Promise<bigint> {
  try {
    return parseQuantity(client, await client.call("eth_estimateGas", [callParams(call)]), "eth_estimateGas")
  } catch (error) {
    throw revertRefusalOf(error) ?? error
  }
}

/**
 * `eth_call` of an ERC-20 `transfer` as `call.from`. A revert, or an answer of exactly one word that is 0 (the
 * token said `false`), is `invalid_argument`; an empty answer passes, as tokens such as USDT return nothing.
 */
export async function simulateTransfer(client: JsonRpcClient, call: EvmCall): Promise<void> {
  const outcome = await ethCall(client, call)
  if (outcome.reverted) throw refusalOfReason(outcome.reason)
  const bytes = bytesOfHex(outcome.data)
  if (bytes?.length === WORD_BYTES && readWord(bytes, 0) === 0n) {
    throw new ToolError("invalid_argument", "The chain would not move the tokens: the token's transfer returned false.")
  }
}

import { ens_normalize } from "@adraffy/ens-normalize"
import { bytesToHex, concatBytes } from "@noble/curves/utils.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { ENS_UNIVERSAL_RESOLVER_ADDRESS, ensChainOf, type EvmChain } from "../chains/evm"
import { ToolError } from "../errors"
import { evmClient, type ClientOptions, type JsonRpcClient } from "../rpc/client"
import { bytesArguments, bytesOfHex, readWord, WORD_BYTES } from "./abi"
import { isEvmAddress, parseEvmAddress } from "./address"
import { callParams, isRevert } from "./reads"

/** A name an ENS lookup resolved: the name as ENSIP-15 normalizes it, and the address it points to in checksum case. */
export type ResolvedName = { name: string; address: string }

/** The first four bytes of the Keccak-256 of each signature the lookup uses, as 8 hex digits. */
export const ENS_SELECTORS = {
  /** `resolve(bytes,bytes)` of the Universal Resolver */
  resolve: "9061b923",
  /** `addr(bytes32)` of a resolver */
  addr: "3b3b57de",
  /** the error `OffchainLookup(address,string[],bytes,bytes4,bytes)` of EIP-3668 */
  offchainLookup: "556f1830",
}

/** The longest name an error quotes back; a longer one is reported by its length. */
const MAX_QUOTED_LENGTH = 100

/** The most of the normalizer's reason an error quotes. */
const MAX_REASON_LENGTH = 200

/** A label is DNS-encoded with a length of one byte. */
const MAX_LABEL_BYTES = 255

/** An address is 20 bytes: 160 bits, or 40 hex digits. */
const ADDRESS_BITS = 160n
const ADDRESS_DIGITS = 40

const ENCODER = new TextEncoder()

function refusal(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

function noAddress(name: string): string {
  return `${name} has no address on ENS.`
}

function quoted(name: string): string {
  return name.length > MAX_QUOTED_LENGTH ? `(${name.length} characters)` : `"${name}"`
}

/** Whether `text` is a name to resolve rather than an address: not `0x` and 40 hex digits, and it holds a dot. */
export function isEnsName(text: string): boolean {
  return !isEvmAddress(text) && text.includes(".")
}

/** The labels of a normalized name, none for the empty name (the root). */
function labelsOf(name: string): string[] {
  return name === "" ? [] : name.split(".")
}

/** `name` as ENSIP-15 normalizes it; a name it refuses is `invalid_argument`, saying why. */
function normalized(name: string): string {
  let result: string
  try {
    result = ens_normalize(name)
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, MAX_REASON_LENGTH) : "it cannot be normalized"
    throw refusal(`${quoted(name)} is not a valid ENS name: ${reason}.`)
  }
  if (result === "" || labelsOf(result).some((label) => ENCODER.encode(label).length > MAX_LABEL_BYTES)) {
    throw refusal(
      `${quoted(name)} is not a valid ENS name: it is empty or has a label of more than ${MAX_LABEL_BYTES} bytes.`,
    )
  }
  return result
}

/** The DNS wire form of a normalized name: each label after its length, then a zero byte. */
export function dnsEncode(name: string): Uint8Array {
  const parts = labelsOf(name).flatMap((label) => {
    const bytes = ENCODER.encode(label)
    return [Uint8Array.of(bytes.length), bytes]
  })
  return concatBytes(...parts, Uint8Array.of(0))
}

/** The ENSIP-1 namehash of a normalized name. */
export function namehash(name: string): Uint8Array {
  let node: Uint8Array = new Uint8Array(WORD_BYTES)
  for (const label of labelsOf(name).reverse()) {
    node = keccak_256(concatBytes(node, keccak_256(ENCODER.encode(label))))
  }
  return node
}

/** The calldata of the Universal Resolver's `resolve(name, addr(node))` for a normalized name. */
function resolveCall(name: string): string {
  const addrCall = `0x${ENS_SELECTORS.addr}${bytesToHex(namehash(name))}`
  return `0x${ENS_SELECTORS.resolve}${bytesArguments([`0x${bytesToHex(dnsEncode(name))}`, addrCall])}`
}

function notAnswer(client: JsonRpcClient): ToolError {
  return new ToolError(
    "upstream_error",
    `${client.name} answered eth_call with something that is not an ENS resolution.`,
  )
}

/** The `result` bytes of the answer `(bytes result, address resolver)`; anything else is `upstream_error`. */
function resultOf(client: JsonRpcClient, answer: unknown): Uint8Array {
  const bytes = bytesOfHex(answer)
  if (!bytes || bytes.length < 2 * WORD_BYTES) throw notAnswer(client)
  const offset = readWord(bytes, 0)
  if (offset % BigInt(WORD_BYTES) !== 0n || offset + BigInt(WORD_BYTES) > BigInt(bytes.length)) throw notAnswer(client)
  const start = Number(offset) + WORD_BYTES
  const length = readWord(bytes, Number(offset) / WORD_BYTES)
  if (length > BigInt(bytes.length - start)) throw notAnswer(client)
  return bytes.subarray(start, start + Number(length))
}

/** The address `addr` returned: one word of 20 bytes after 12 zeros. `undefined` for the zero address and for anything else. */
function addressOf(result: Uint8Array): string | undefined {
  if (result.length !== WORD_BYTES) return undefined
  const value = readWord(result, 0)
  if (value === 0n || value >> ADDRESS_BITS !== 0n) return undefined
  return parseEvmAddress(`0x${value.toString(16).padStart(ADDRESS_DIGITS, "0")}`)
}

/** Whether a node's revert is EIP-3668's `OffchainLookup`, by its data or, from a node that puts it in the message, by the message. */
function isOffchainLookup({ message, data }: { message: string; data?: unknown }): boolean {
  const selector = `0x${ENS_SELECTORS.offchainLookup}`
  return (
    (typeof data === "string" && data.toLowerCase().startsWith(selector)) || message.toLowerCase().includes(selector)
  )
}

/**
 * The address `name` points to on ENS, through the Universal Resolver of the ENS chain of `chain` (Ethereum for a
 * mainnet, Sepolia for a testnet) with a plain `eth_call`: no URL is ever fetched. The name is normalized first
 * (ENSIP-15) and the normalized name is returned. `invalid_argument` for a name the normalizer refuses, one that
 * needs an off-chain lookup (EIP-3668), which no tool follows, and one with no address or the zero address; a read
 * that fails, or an answer that is no resolution, is `upstream_error`.
 */
export async function resolveEnsName(name: string, chain: EvmChain, options: ClientOptions): Promise<ResolvedName> {
  const resolved = normalized(name)
  const client = evmClient(ensChainOf(chain), options)
  const call = callParams({ to: ENS_UNIVERSAL_RESOLVER_ADDRESS, data: resolveCall(resolved) })
  let answer: unknown
  try {
    answer = await client.call("eth_call", [call, "latest"])
  } catch (error) {
    if (!isRevert(error)) throw error
    throw refusal(
      isOffchainLookup(error.rpc)
        ? `${resolved} resolves off-chain (EIP-3668), which no tool follows; give its address instead.`
        : noAddress(resolved),
    )
  }
  const address = addressOf(resultOf(client, answer))
  if (address === undefined) throw refusal(noAddress(resolved))
  return { name: resolved, address }
}

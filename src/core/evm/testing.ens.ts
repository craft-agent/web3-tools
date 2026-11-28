import { bytesToHex, hexToBytes } from "@noble/curves/utils.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { ENS_UNIVERSAL_RESOLVER_ADDRESS } from "../chains/evm"
import { abiString, addressWord, bytesOfHex, readWord, word, WORD_BYTES } from "./abi"
import { selectorOf, type CallOutcome } from "./testing.contracts"

/** What the fake's Universal Resolver knows of a name: the address it points to, or that its resolver needs an off-chain lookup. */
export type FakeEnsEntry = { address: string } | "offchain"

/** The URL the fake's `OffchainLookup` revert asks a client to fetch; a test asserts nothing ever does. */
export const OFFCHAIN_LOOKUP_URL = "https://ccip.example.org/{sender}/{data}.json"

const SELECTOR_BYTES = 4

/** The Universal Resolver's functions and errors, selected the way Solidity does. */
const SELECTORS = {
  resolve: selectorOf("resolve(bytes,bytes)"),
  addr: selectorOf("addr(bytes32)"),
  offchainLookup: selectorOf("OffchainLookup(address,string[],bytes,bytes4,bytes)"),
  resolverNotFound: selectorOf("ResolverNotFound(bytes)"),
}

const CALLBACK_SELECTOR = "12345678"

/** The namehash of `name` as 64 hex digits, written as ENSIP-1 defines it: the parent's node, then the label's hash. */
function nodeOf(name: string): string {
  if (name === "") return "0".repeat(WORD_BYTES * 2)
  const dot = name.indexOf(".")
  const label = dot < 0 ? name : name.slice(0, dot)
  const parent = nodeOf(dot < 0 ? "" : name.slice(dot + 1))
  const joined = new Uint8Array([...hexToBytes(parent), ...keccak_256(new TextEncoder().encode(label))])
  return bytesToHex(keccak_256(joined))
}

/** The bytes at the offset the parameter at `index` holds, after the selector: `undefined` when they do not fit. */
function bytesParameter(args: Uint8Array, index: number): Uint8Array | undefined {
  const offset = Number(readWord(args, index))
  if (offset + WORD_BYTES > args.length) return undefined
  const length = Number(readWord(args, offset / WORD_BYTES))
  return offset + WORD_BYTES + length > args.length
    ? undefined
    : args.subarray(offset + WORD_BYTES, offset + WORD_BYTES + length)
}

/** The name a DNS-encoded name spells, or `undefined` for bytes that are not one. */
function decodeDns(bytes: Uint8Array): string | undefined {
  const labels: string[] = []
  for (let at = 0; at < bytes.length;) {
    const length = bytes[at]!
    if (length === 0) return at === bytes.length - 1 ? labels.join(".") : undefined
    labels.push(new TextDecoder().decode(bytes.subarray(at + 1, at + 1 + length)))
    at += 1 + length
  }
  return undefined
}

/** The data of `OffchainLookup(sender, [url], "", callback, "")`, as a resolver that needs a gateway reverts with it. */
function offchainLookupData(): string {
  const urls = `${word(1n)}${abiString(OFFCHAIN_LOOKUP_URL).slice(2)}`
  const urlsOffset = 5 * WORD_BYTES
  const emptyBytesOffset = urlsOffset + urls.length / 2
  const head = [
    addressWord(ENS_UNIVERSAL_RESOLVER_ADDRESS),
    word(BigInt(urlsOffset)),
    word(BigInt(emptyBytesOffset)),
    CALLBACK_SELECTOR.padEnd(WORD_BYTES * 2, "0"),
    word(BigInt(emptyBytesOffset + WORD_BYTES)),
  ]
  return `0x${SELECTORS.offchainLookup}${head.join("")}${urls}${word(0n)}${word(0n)}`
}

/** What a call to the fake's Universal Resolver (the caller checks `to`) answers, from the names it holds. */
export function ensOutcome(names: ReadonlyMap<string, FakeEnsEntry>, data: string): CallOutcome {
  const bytes = bytesOfHex(data)
  if (!bytes || bytesToHex(bytes.subarray(0, SELECTOR_BYTES)) !== SELECTORS.resolve) return { revert: "" }
  const args = bytes.subarray(SELECTOR_BYTES)
  const dns = bytesParameter(args, 0)
  const call = bytesParameter(args, 1)
  const name = dns && decodeDns(dns)
  if (name === undefined || name === "" || !call) return { revert: "" }
  const [selector, node] = [bytesToHex(call.subarray(0, SELECTOR_BYTES)), bytesToHex(call.subarray(SELECTOR_BYTES))]
  const entry = names.get(name)
  if (selector !== SELECTORS.addr || node !== nodeOf(name)) return { revert: "" }
  if (entry === undefined) return { revert: "", data: `0x${SELECTORS.resolverNotFound}` }
  if (entry === "offchain") return { revert: "", data: offchainLookupData() }
  const answer = [
    word(BigInt(2 * WORD_BYTES)),
    addressWord(ENS_UNIVERSAL_RESOLVER_ADDRESS),
    word(BigInt(WORD_BYTES)),
    word(BigInt(entry.address)),
  ]
  return { returns: `0x${answer.join("")}` }
}

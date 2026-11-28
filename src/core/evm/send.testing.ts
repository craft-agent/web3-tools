import { bytesToHex, hexToBytes } from "@noble/curves/utils.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import type { z } from "zod"
import type { ToolSpec } from "../tool"
import { makeToolRig, type ToolRig, type WalletRigOptions } from "../write/testing"
import { defineEvmSend, type SendDeps } from "./send"
import type { sendOutput } from "./send.schema"
import { FakeEvmChain } from "./testing"
import { HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1 } from "./testing.sign"

export { cleanRigs, expectRefused, NOW } from "../write/testing"

export const GWEI = 10n ** 9n
export const ETHER = 10n ** 18n

/** A token address, as Base's USDC is written. */
export const TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

/** A fee ceiling that covers a plain transfer and a token's transfer with room to spare, in wei. */
export const MAX_FEE = "200000000000000"

/** An NFT collection address, as Bored Ape Yacht Club's is written. */
export const COLLECTION_ADDRESS = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D"

/** The ERC-165 ids of ERC-721 and ERC-1155, for a fake collection's `interfaces`. */
export const ERC721_ID = "0x80ac58cd"
export const ERC1155_ID = "0xd9b67a26"

/** The result of the tool. */
export type SendResult = z.output<typeof sendOutput>

/** The hash of a raw transaction, as a node and the ledger know it. */
export function hashOfRaw(raw: string): string {
  return `0x${bytesToHex(keccak_256(hexToBytes(raw.slice(2))))}`
}

/** The raw arguments of a send from the wallet `main` to Hardhat's second account. */
export function nativeArgs(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { chain: "ethereum", account: "main", to: HARDHAT_ADDRESS_1, amount: "1", max_fee: MAX_FEE, ...changes }
}

/** The raw arguments of a send of `TOKEN_ADDRESS`. */
export function tokenArgs(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return nativeArgs({ token: TOKEN_ADDRESS, amount: "5", ...changes })
}

/** The raw arguments of a send of the NFT `token_id` "7" of `COLLECTION_ADDRESS`, a count of 1. */
export function nftArgs(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return nativeArgs({ token: COLLECTION_ADDRESS, token_id: "7", amount: "1", ...changes })
}

/** The rig of an EVM write tool: its fake is a `FakeEvmChain`. */
export type EvmToolRig<Spec extends ToolSpec> = ToolRig<Spec, FakeEvmChain>

/** The rig of `web3_evm_send`. */
export type SendRig = EvmToolRig<ReturnType<typeof defineEvmSend>>

/** What a rig is set up with: the chain's key, the wallets, and the call's settings. */
export type RigOptions = WalletRigOptions & { chain?: string }

/** The rig of `web3_evm_send`: see `makeEvmToolRig`. */
export function makeRig(options: RigOptions = {}): SendRig {
  return makeEvmToolRig(defineEvmSend, options)
}

/**
 * The rig of an EVM write tool: `main` holds 10 coins, and a token at `TOKEN_ADDRESS` gives it 1000 of its units.
 * See `makeToolRig` for the rest of what it is set up with.
 */
export function makeEvmToolRig<Spec extends ToolSpec>(
  define: (deps: SendDeps) => Spec,
  { chain = "ethereum", ...rest }: RigOptions = {},
): EvmToolRig<Spec> {
  const fake = new FakeEvmChain(chain).setBalance(HARDHAT_ADDRESS_0, 10n * ETHER)
  fake.addErc20(TOKEN_ADDRESS, { balances: { [HARDHAT_ADDRESS_0]: 1000n * ETHER }, symbol: "TKN" })
  return makeToolRig(
    define,
    fake,
    (node) => node.requestsOf("eth_sendRawTransaction").map(([raw]) => String(raw)),
    rest,
  )
}

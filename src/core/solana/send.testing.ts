import { ed25519 } from "@noble/curves/ed25519.js"
import { base58 } from "@scure/base"
import type { z } from "zod"
import { ABANDON_PHRASE, SOLANA_KEYPAIR_BASE58 } from "../signer/testing"
import type { ToolSpec } from "../tool"
import { makeToolRig, type ToolRig, type WalletRigOptions } from "../write/testing"
import { defineSolanaSend, type SendDeps } from "./send"
import type { sendOutput } from "./send.schema"
import { testAddress } from "./testing"
import { FakeSolanaCluster, type LandedTransaction } from "./testing.cluster"
import { decodeTransaction } from "./testing.cluster.tx"

export { cleanRigs, expectRefused, NOW } from "../write/testing"

export const LAMPORTS_PER_SOL = 10n ** 9n

/** The address of the wallet `main` of the rig: the Solana keypair of the signer's fixtures. */
export const MAIN_ADDRESS = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(7)))

/** A wallet with no account yet, and a token mint the rig knows. */
export const BOB = testAddress(2)
export const MINT = testAddress(3)

/** A fee ceiling that covers a send with room to spare, in lamports. */
export const MAX_FEE = "100000"

/** The tokens `main` holds of `MINT`: 1000 of a token with 6 decimals, in its smallest unit. */
export const MAIN_TOKENS = 1_000_000_000n

/** The result of the tool. */
export type SendResult = z.output<typeof sendOutput>

/** A fake cluster that lands its pending transactions when the wait first pauses. */
export class RigCluster extends FakeSolanaCluster {
  mine(): LandedTransaction[] {
    return this.land()
  }
}

/** The rig of a Solana write tool: its fake is a `RigCluster`. */
export type SolanaToolRig<Spec extends ToolSpec> = ToolRig<Spec, RigCluster>

/** The rig of `web3_solana_send`. */
export type SendRig = SolanaToolRig<ReturnType<typeof defineSolanaSend>>

/** What a rig is set up with: the cluster's key, the wallets, and the call's settings. */
export type RigOptions = WalletRigOptions & { chain?: string }

/** The raw arguments of a send of 1 SOL from the wallet `main` to `BOB`. */
export function solArgs(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { chain: "solana", account: "main", to: BOB, amount: "1", max_fee: MAX_FEE, ...changes }
}

/** The raw arguments of a send of 5 of `MINT` from the wallet `main` to `BOB`. */
export function tokenArgs(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return solArgs({ mint: MINT, amount: "5", ...changes })
}

/** The signatures of the transactions the rig's fake received, in order. */
export function signaturesOf(rig: SendRig): string[] {
  return rig.broadcasts().map((raw) => decodeTransaction(raw).signature)
}

/** The rig of `web3_solana_send`: see `makeSolanaToolRig`. */
export function makeRig(options: RigOptions = {}): SendRig {
  return makeSolanaToolRig(defineSolanaSend, options)
}

/**
 * The rig of a Solana write tool: the wallet `main` is a Solana keypair holding 10 SOL and 1000 of `MINT`, a token
 * with 6 decimals and the symbol TKN, in its associated token account, and `savings` is a seed phrase. See
 * `makeToolRig` for the rest of what it is set up with.
 */
export function makeSolanaToolRig<Spec extends ToolSpec>(
  define: (deps: SendDeps) => Spec,
  { chain = "solana", wallets, ...rest }: RigOptions = {},
): SolanaToolRig<Spec> {
  const fake = new RigCluster(chain).setBalance(MAIN_ADDRESS, 10n * LAMPORTS_PER_SOL)
  fake.addMint(MINT, { decimals: 6, supply: MAIN_TOKENS })
  fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, { amount: MAIN_TOKENS })
  fake.addMetadata({ mint: MINT, symbol: "TKN", tokenStandard: null })
  const keys = wallets ?? { WEB3_TOOLS_WALLET_MAIN: SOLANA_KEYPAIR_BASE58, WEB3_TOOLS_WALLET_SAVINGS: ABANDON_PHRASE }
  return makeToolRig(define, fake, (node) => node.requestsOf("sendTransaction").map(([raw]) => String(raw)), {
    ...rest,
    wallets: keys,
  })
}

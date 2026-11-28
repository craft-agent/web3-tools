import { z } from "zod"
import { WRITE_OUTCOMES } from "../write/types"
import { sendInput } from "./send.schema"

/** What a revoke takes back: the delegate a token account approved to move its tokens. */
export const REVOKED = "delegate" as const

/** The arguments of `web3_solana_revoke`: whose approval of which token, and the ceiling on the fee. */
export const revokeInput = z.object({
  chain: sendInput.shape.chain,
  account: sendInput.shape.account,
  mint: z
    .string()
    .describe(
      "The token mint's address in base58, whose delegate on the wallet's associated token account is revoked.",
    ),
  max_fee: sendInput.shape.max_fee,
})

/** The result of `web3_solana_revoke`. */
export const revokeOutput = z.object({
  chain: z.string().describe("The cluster's key."),
  signature: z.string().describe("The transaction's signature, which is its id."),
  outcome: z.enum(WRITE_OUTCOMES).describe("confirmed, failed or pending."),
  ledger_row: z.string().describe("The id of the revoke's row in the ledger."),
  from: z.string().describe("The wallet's address, whose approval was revoked."),
  mint: z.string().describe("The token mint's address."),
  delegate: z.string().describe("The address whose approval to move the tokens was revoked."),
  revoked: z.literal(REVOKED).describe("What was revoked: the token account's delegate."),
  slot: z.string().nullable().describe("The slot the transaction landed in; null while pending."),
  explorer: z.string().describe("The transaction's page on the cluster's block explorer."),
})

/** The arguments of a revoke, as `invoke` hands them over. */
export type SolanaRevokeArgs = z.output<typeof revokeInput>

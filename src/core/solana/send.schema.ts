import { z } from "zod"
import { SOLANA_CHAIN_KEYS } from "../chains/solana"
import { WRITE_OUTCOMES } from "../write/types"

/** The arguments of `web3_solana_send`: the whole change, and the ceiling on its fee. */
export const sendInput = z.object({
  chain: z.enum(SOLANA_CHAIN_KEYS).describe("The cluster, by its key; there is no default."),
  account: z
    .string()
    .optional()
    .describe(
      "The sending wallet: its label, with #<index> for an account of a seed phrase (main#3). Left out, the only wallet.",
    ),
  to: z
    .string()
    .describe(
      "The recipient: the owner's wallet address in base58, never a token account; its token account is found or made.",
    ),
  mint: z.string().optional().describe("The token mint's address in base58, or a plain NFT's; left out, SOL."),
  amount: z
    .string()
    .describe("How much, as a decimal string in the token's own units, such as 1.5; never rounded. For an NFT, 1."),
  max_fee: z
    .string()
    .describe(
      "The most the whole fee (base and priority) may cost, in lamports, as digits. It must leave room above what the network asks now.",
    ),
})

/** The result of `web3_solana_send`. */
export const sendOutput = z.object({
  chain: z.string().describe("The cluster's key."),
  signature: z.string().describe("The transaction's signature, which is its id."),
  outcome: z.enum(WRITE_OUTCOMES).describe("confirmed, failed or pending."),
  ledger_row: z.string().describe("The id of the send's row in the ledger."),
  from: z.string().describe("The sender's address."),
  to: z.string().describe("The recipient's wallet address."),
  mint: z.string().nullable().describe("The token mint's address; null for SOL."),
  nft: z.boolean().describe("Whether what was sent is a plain NFT."),
  amount: z.string().describe("The amount sent, in the token's units; 1 for an NFT."),
  symbol: z.string().nullable().describe("SOL, or the token's declared symbol; null when it has none to show."),
  slot: z.string().nullable().describe("The slot the transaction landed in; null while pending."),
  explorer: z.string().describe("The transaction's page on the cluster's block explorer."),
})

/** The arguments of a send, as `invoke` hands them over. */
export type SolanaSendArgs = z.output<typeof sendInput>

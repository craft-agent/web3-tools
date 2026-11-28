import { ToolError } from "../errors"
import type { NativeCoin } from "./evm"

/** One Solana cluster of the fixed table. */
export type SolanaChain = {
  /** The name a call gives the cluster by. */
  readonly key: string
  readonly name: string
  /** Solana's own name for the cluster, as explorers take it. */
  readonly cluster: "mainnet-beta" | "devnet"
  readonly native: NativeCoin
  readonly testnet: boolean
  /** A testnet's mainnet, by key. */
  readonly mainnet?: string
  readonly explorer: string
  /** The public JSON-RPC endpoint, used when no provider key is set. */
  readonly rpc: string
  /** Helius's network, as in `https://<network>.helius-rpc.com`. */
  readonly helius: "mainnet" | "devnet"
}

const SOL: NativeCoin = { symbol: "SOL", decimals: 9 }

/** Every Solana cluster the tools reach; a call names one by its key and never by a URL. */
export const SOLANA_CHAINS = [
  {
    key: "solana",
    name: "Solana",
    cluster: "mainnet-beta",
    native: SOL,
    testnet: false,
    explorer: "https://explorer.solana.com",
    rpc: "https://api.mainnet-beta.solana.com",
    helius: "mainnet",
  },
  {
    key: "solana-devnet",
    name: "Solana Devnet",
    cluster: "devnet",
    native: SOL,
    testnet: true,
    mainnet: "solana",
    explorer: "https://explorer.solana.com",
    rpc: "https://api.devnet.solana.com",
    helius: "devnet",
  },
] as const satisfies readonly SolanaChain[]

/** The programs a Solana write names, the same on every cluster; no call supplies one. */
export const SOLANA_PROGRAMS = {
  systemProgram: "11111111111111111111111111111111",
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022Program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  associatedTokenProgram: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  computeBudgetProgram: "ComputeBudget111111111111111111111111111111",
  tokenMetadataProgram: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
} as const

/** The two token programs a transfer may run under: Token and Token-2022. */
export const TOKEN_PROGRAMS: readonly string[] = [SOLANA_PROGRAMS.tokenProgram, SOLANA_PROGRAMS.token2022Program]

/** The key of a cluster in the table. */
export type SolanaChainKey = (typeof SOLANA_CHAINS)[number]["key"]

/** Every key, in the table's order, for an argument's enum. */
export const SOLANA_CHAIN_KEYS = SOLANA_CHAINS.map((chain) => chain.key) as [SolanaChainKey, ...SolanaChainKey[]]

/** The cluster a key names; an unknown key is `invalid_argument` and lists the keys. */
export function solanaChain(key: string): SolanaChain {
  const chain = SOLANA_CHAINS.find((entry) => entry.key === key)
  if (!chain) {
    throw new ToolError(
      "invalid_argument",
      `No Solana cluster "${key}"; the clusters are ${SOLANA_CHAIN_KEYS.join(", ")}.`,
    )
  }
  return chain
}

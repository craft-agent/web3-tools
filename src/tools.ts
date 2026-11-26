import type { ToolSpec } from "./core"
import { web3EvmRead } from "./core/evm/read"
import { web3SolanaRead } from "./core/solana/read"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [web3EvmRead, web3SolanaRead]

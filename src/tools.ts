import type { ToolSpec } from "./core"
import { web3EvmRead } from "./core/evm/read"
import { web3EvmRevoke } from "./core/evm/revoke"
import { web3EvmSend } from "./core/evm/send"
import { web3SolanaRead } from "./core/solana/read"
import { web3SolanaRevoke } from "./core/solana/revoke"
import { web3SolanaSend } from "./core/solana/send"
import { web3WalletRead } from "./core/wallet/read"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [
  web3EvmRead,
  web3EvmRevoke,
  web3EvmSend,
  web3SolanaRead,
  web3SolanaRevoke,
  web3SolanaSend,
  web3WalletRead,
]

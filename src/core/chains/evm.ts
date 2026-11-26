import { ToolError } from "../errors"

/**
 * What an EVM chain charges a transaction beyond `gasLimit × maxFeePerGas`, and so how a fee ceiling is checked:
 * `gas` nothing beyond gas; `linea` nothing beyond gas, but only `linea_estimateGas` prices the L1 data;
 * `op` the OP Stack `GasPriceOracle`'s L1 data fee and operator fee; `mantle` the same, with the L1 fee in MNT
 * through `tokenRatio()`; `scroll` the `L1GasPriceOracle`'s L1 data fee.
 */
export type FeeModel = "gas" | "linea" | "op" | "mantle" | "scroll"

/** A chain's native coin. */
export type NativeCoin = { readonly symbol: string; readonly decimals: number }

/** One EVM chain of the fixed table. */
export type EvmChain = {
  /** The name a call gives the chain by. */
  readonly key: string
  readonly chainId: number
  readonly name: string
  readonly native: NativeCoin
  readonly testnet: boolean
  /** A testnet's mainnet, by key. */
  readonly mainnet?: string
  readonly explorer: string
  /** The public JSON-RPC endpoint, used when no provider serves the chain. */
  readonly rpc: string
  /** Alchemy's network name, as in `https://<network>.g.alchemy.com/v2`; absent where Alchemy does not serve it. */
  readonly alchemy?: string
  readonly fee: FeeModel
  /** Where the native coin also answers as an ERC-20, so a balance is never counted twice. */
  readonly nativeToken?: string
}

const ETH: NativeCoin = { symbol: "ETH", decimals: 18 }

/** Every EVM chain the tools reach; a call names one by its key and never by a URL or a chain id. */
export const EVM_CHAINS = [
  {
    key: "ethereum",
    chainId: 1,
    name: "Ethereum",
    native: ETH,
    testnet: false,
    explorer: "https://etherscan.io",
    rpc: "https://ethereum-rpc.publicnode.com",
    alchemy: "eth-mainnet",
    fee: "gas",
  },
  {
    key: "base",
    chainId: 8453,
    name: "Base",
    native: ETH,
    testnet: false,
    explorer: "https://basescan.org",
    rpc: "https://mainnet.base.org",
    alchemy: "base-mainnet",
    fee: "op",
  },
  {
    key: "arbitrum",
    chainId: 42161,
    name: "Arbitrum One",
    native: ETH,
    testnet: false,
    explorer: "https://arbiscan.io",
    rpc: "https://arb1.arbitrum.io/rpc",
    alchemy: "arb-mainnet",
    fee: "gas",
  },
  {
    key: "optimism",
    chainId: 10,
    name: "OP Mainnet",
    native: ETH,
    testnet: false,
    explorer: "https://optimistic.etherscan.io",
    rpc: "https://mainnet.optimism.io",
    alchemy: "opt-mainnet",
    fee: "op",
  },
  {
    key: "polygon",
    chainId: 137,
    name: "Polygon PoS",
    native: { symbol: "POL", decimals: 18 },
    testnet: false,
    explorer: "https://polygonscan.com",
    rpc: "https://polygon.drpc.org",
    alchemy: "polygon-mainnet",
    fee: "gas",
  },
  {
    key: "bnb",
    chainId: 56,
    name: "BNB Smart Chain",
    native: { symbol: "BNB", decimals: 18 },
    testnet: false,
    explorer: "https://bscscan.com",
    rpc: "https://bsc-dataseed.bnbchain.org",
    alchemy: "bnb-mainnet",
    fee: "gas",
  },
  {
    key: "avalanche",
    chainId: 43114,
    name: "Avalanche C-Chain",
    native: { symbol: "AVAX", decimals: 18 },
    testnet: false,
    explorer: "https://snowtrace.io",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    alchemy: "avax-mainnet",
    fee: "gas",
  },
  {
    key: "linea",
    chainId: 59144,
    name: "Linea",
    native: ETH,
    testnet: false,
    explorer: "https://lineascan.build",
    rpc: "https://rpc.linea.build",
    alchemy: "linea-mainnet",
    fee: "linea",
  },
  {
    key: "scroll",
    chainId: 534352,
    name: "Scroll",
    native: ETH,
    testnet: false,
    explorer: "https://scrollscan.com",
    rpc: "https://rpc.scroll.io",
    alchemy: "scroll-mainnet",
    fee: "scroll",
  },
  {
    key: "zksync",
    chainId: 324,
    name: "ZKsync Era",
    native: ETH,
    testnet: false,
    explorer: "https://explorer.zksync.io",
    rpc: "https://mainnet.era.zksync.io",
    alchemy: "zksync-mainnet",
    fee: "gas",
  },
  {
    key: "unichain",
    chainId: 130,
    name: "Unichain",
    native: ETH,
    testnet: false,
    explorer: "https://uniscan.xyz",
    rpc: "https://mainnet.unichain.org",
    alchemy: "unichain-mainnet",
    fee: "op",
  },
  {
    key: "gnosis",
    chainId: 100,
    name: "Gnosis",
    native: { symbol: "xDAI", decimals: 18 },
    testnet: false,
    explorer: "https://gnosisscan.io",
    rpc: "https://rpc.gnosischain.com",
    alchemy: "gnosis-mainnet",
    fee: "gas",
  },
  {
    key: "celo",
    chainId: 42220,
    name: "Celo",
    native: { symbol: "CELO", decimals: 18 },
    testnet: false,
    explorer: "https://celoscan.io",
    rpc: "https://forno.celo.org",
    alchemy: "celo-mainnet",
    fee: "op",
    nativeToken: "0x471EcE3750Da237f93B8E339c536989b8978a438",
  },
  {
    key: "mantle",
    chainId: 5000,
    name: "Mantle",
    native: { symbol: "MNT", decimals: 18 },
    testnet: false,
    explorer: "https://mantlescan.xyz",
    rpc: "https://rpc.mantle.xyz",
    alchemy: "mantle-mainnet",
    fee: "mantle",
  },
  {
    key: "sonic",
    chainId: 146,
    name: "Sonic",
    native: { symbol: "S", decimals: 18 },
    testnet: false,
    explorer: "https://sonicscan.org",
    rpc: "https://rpc.soniclabs.com",
    alchemy: "sonic-mainnet",
    fee: "gas",
  },
  {
    key: "world-chain",
    chainId: 480,
    name: "World Chain",
    native: ETH,
    testnet: false,
    explorer: "https://worldscan.org",
    rpc: "https://worldchain-mainnet.g.alchemy.com/public",
    alchemy: "worldchain-mainnet",
    fee: "op",
  },
  {
    key: "ink",
    chainId: 57073,
    name: "Ink",
    native: ETH,
    testnet: false,
    explorer: "https://explorer.inkonchain.com",
    rpc: "https://rpc-gel.inkonchain.com",
    alchemy: "ink-mainnet",
    fee: "op",
  },
  {
    key: "zora",
    chainId: 7777777,
    name: "Zora",
    native: ETH,
    testnet: false,
    explorer: "https://explorer.zora.energy",
    rpc: "https://rpc.zora.energy",
    alchemy: "zora-mainnet",
    fee: "op",
  },
] as const satisfies readonly EvmChain[]

/** The key of a chain in the table. */
export type EvmChainKey = (typeof EVM_CHAINS)[number]["key"]

/** Every key, in the table's order, for an argument's enum. */
export const EVM_CHAIN_KEYS = EVM_CHAINS.map((chain) => chain.key) as [EvmChainKey, ...EvmChainKey[]]

/** The chain a key names; an unknown key is `invalid_argument` and lists the keys. */
export function evmChain(key: string): EvmChain {
  const chain = EVM_CHAINS.find((entry) => entry.key === key)
  if (!chain) {
    throw new ToolError("invalid_argument", `No EVM chain "${key}"; the chains are ${EVM_CHAIN_KEYS.join(", ")}.`)
  }
  return chain
}

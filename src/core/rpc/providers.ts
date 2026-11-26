import type { EvmChain } from "../chains/evm"
import type { SolanaChain } from "../chains/solana"

/** The environment a key is read from. */
export type Env = Readonly<Record<string, string | undefined>>

/** The variable holding the Alchemy key, which serves the EVM chains that have an Alchemy network. */
export const ALCHEMY_KEY_VARIABLE = "ALCHEMY_API_KEY"

/** The variable holding the Helius key, which serves Solana. */
export const HELIUS_KEY_VARIABLE = "HELIUS_API_KEY"

/** Who answers a call: a provider the key selects, or the chain table's public endpoint. */
export type Provider = "alchemy" | "helius" | "public"

/** Where a call goes: never shown, since a Helius URL carries its key. */
export type Endpoint = {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly provider: Provider
}

const PROVIDER_LABELS: Readonly<Record<Provider, string>> = {
  alchemy: "Alchemy",
  helius: "Helius",
  public: "public endpoint",
}

function keyFrom(env: Env, variable: string): string | undefined {
  const key = env[variable]?.trim()
  return key ? key : undefined
}

/** The provider that serves an EVM chain under `env`, without building anything that carries a key. */
export function evmProvider(chain: EvmChain, env: Env = process.env): Provider {
  return chain.alchemy !== undefined && keyFrom(env, ALCHEMY_KEY_VARIABLE) !== undefined ? "alchemy" : "public"
}

/** The provider that serves a Solana cluster under `env`, without building anything that carries a key. */
export function solanaProvider(_chain: SolanaChain, env: Env = process.env): Provider {
  return keyFrom(env, HELIUS_KEY_VARIABLE) !== undefined ? "helius" : "public"
}

/** Where a call to an EVM chain goes: Alchemy with the key as a bearer token when it serves the chain, else the public endpoint. */
export function evmEndpoint(chain: EvmChain, env: Env = process.env): Endpoint {
  const key = keyFrom(env, ALCHEMY_KEY_VARIABLE)
  if (key !== undefined && chain.alchemy !== undefined) {
    return {
      url: `https://${chain.alchemy}.g.alchemy.com/v2`,
      headers: { authorization: `Bearer ${key}` },
      provider: "alchemy",
    }
  }
  return { url: chain.rpc, headers: {}, provider: "public" }
}

/** Where a call to a Solana cluster goes: Helius with the key in the URL when it is set, else the public endpoint. */
export function solanaEndpoint(chain: SolanaChain, env: Env = process.env): Endpoint {
  const key = keyFrom(env, HELIUS_KEY_VARIABLE)
  if (key !== undefined) {
    return {
      url: `https://${chain.helius}.helius-rpc.com/?api-key=${encodeURIComponent(key)}`,
      headers: {},
      provider: "helius",
    }
  }
  return { url: chain.rpc, headers: {}, provider: "public" }
}

/** Every provider key that is set, as the value to mask from anything a client returns or throws. */
export function providerSecrets(env: Env = process.env): string[] {
  return [ALCHEMY_KEY_VARIABLE, HELIUS_KEY_VARIABLE].flatMap((variable) => keyFrom(env, variable) ?? [])
}

/** How a provider is named in a message. */
export function providerLabel(provider: Provider): string {
  return PROVIDER_LABELS[provider]
}

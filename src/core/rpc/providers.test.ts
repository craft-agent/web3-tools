import { describe, expect, test } from "bun:test"
import { evmChain } from "../chains/evm"
import { solanaChain } from "../chains/solana"
import {
  ALCHEMY_KEY_VARIABLE,
  HELIUS_KEY_VARIABLE,
  evmEndpoint,
  evmProvider,
  providerLabel,
  providerSecrets,
  solanaEndpoint,
  solanaProvider,
} from "./providers"

const base = evmChain("base")
const scrollSepolia = evmChain("scroll-sepolia")
const solana = solanaChain("solana")
const devnet = solanaChain("solana-devnet")

describe("evmEndpoint", () => {
  test("a set key sends the call to Alchemy with the key as a bearer token, never in the URL", () => {
    const endpoint = evmEndpoint(base, { [ALCHEMY_KEY_VARIABLE]: " alch-key \n" })

    expect(endpoint).toEqual({
      url: "https://base-mainnet.g.alchemy.com/v2",
      headers: { authorization: "Bearer alch-key" },
      provider: "alchemy",
    })
    expect(endpoint.url).not.toContain("alch-key")
  })

  test("no key, a blank key or the other provider's key keeps the public endpoint", () => {
    for (const env of [
      {},
      { [ALCHEMY_KEY_VARIABLE]: "" },
      { [ALCHEMY_KEY_VARIABLE]: "  " },
      { [HELIUS_KEY_VARIABLE]: "k" },
    ]) {
      expect(evmEndpoint(base, env)).toEqual({ url: base.rpc, headers: {}, provider: "public" })
    }
  })

  test("a chain Alchemy does not serve stays public even with a key", () => {
    const env = { [ALCHEMY_KEY_VARIABLE]: "alch-key" }

    expect(evmEndpoint(scrollSepolia, env)).toEqual({ url: scrollSepolia.rpc, headers: {}, provider: "public" })
    expect(evmProvider(scrollSepolia, env)).toBe("public")
  })

  test("reads process.env when no environment is given", () => {
    const saved = process.env[ALCHEMY_KEY_VARIABLE]
    process.env[ALCHEMY_KEY_VARIABLE] = "from-process"
    try {
      expect(evmEndpoint(base).headers.authorization).toBe("Bearer from-process")
      expect(evmProvider(base)).toBe("alchemy")
    } finally {
      if (saved === undefined) delete process.env[ALCHEMY_KEY_VARIABLE]
      else process.env[ALCHEMY_KEY_VARIABLE] = saved
    }
  })
})

describe("solanaEndpoint", () => {
  test("a set key puts the encoded key in the Helius URL of the cluster's network", () => {
    expect(solanaEndpoint(solana, { [HELIUS_KEY_VARIABLE]: " a/b+c " })).toEqual({
      url: "https://mainnet.helius-rpc.com/?api-key=a%2Fb%2Bc",
      headers: {},
      provider: "helius",
    })
    expect(solanaEndpoint(devnet, { [HELIUS_KEY_VARIABLE]: "k" }).url).toBe("https://devnet.helius-rpc.com/?api-key=k")
  })

  test("no key or a blank key keeps the public endpoint", () => {
    for (const env of [{}, { [HELIUS_KEY_VARIABLE]: " " }, { [ALCHEMY_KEY_VARIABLE]: "k" }]) {
      expect(solanaEndpoint(solana, env)).toEqual({ url: solana.rpc, headers: {}, provider: "public" })
    }
  })
})

describe("provider helpers", () => {
  test("evmProvider and solanaProvider name the provider without an endpoint", () => {
    expect(evmProvider(base, { [ALCHEMY_KEY_VARIABLE]: "k" })).toBe("alchemy")
    expect(evmProvider(base, {})).toBe("public")
    expect(solanaProvider(solana, { [HELIUS_KEY_VARIABLE]: "k" })).toBe("helius")
    expect(solanaProvider(solana, { [HELIUS_KEY_VARIABLE]: "" })).toBe("public")
  })

  test("providerLabel", () => {
    expect(providerLabel("alchemy")).toBe("Alchemy")
    expect(providerLabel("helius")).toBe("Helius")
    expect(providerLabel("public")).toBe("public endpoint")
  })

  test("providerSecrets lists every key that is set, trimmed", () => {
    expect(providerSecrets({ [ALCHEMY_KEY_VARIABLE]: " a ", [HELIUS_KEY_VARIABLE]: "h" })).toEqual(["a", "h"])
    expect(providerSecrets({ [ALCHEMY_KEY_VARIABLE]: "  ", [HELIUS_KEY_VARIABLE]: "h" })).toEqual(["h"])
    expect(providerSecrets({})).toEqual([])
  })
})

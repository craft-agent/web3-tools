import { describe, expect, test } from "bun:test"
import { isToolError } from "../errors"
import { EVM_CHAINS, EVM_CHAIN_KEYS, evmChain, type EvmChain } from "./evm"

const chains: readonly EvmChain[] = EVM_CHAINS

describe("the EVM chain table", () => {
  test("keys and chain ids are unique, and keys are lowercase words joined by -", () => {
    expect(new Set(chains.map((chain) => chain.key)).size).toBe(chains.length)
    expect(new Set(chains.map((chain) => chain.chainId)).size).toBe(chains.length)
    for (const chain of chains) {
      expect(chain.key).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      expect(Number.isSafeInteger(chain.chainId) && chain.chainId > 0).toBe(true)
    }
  })

  test("every endpoint and explorer is an https origin or path with no credentials, query or fragment", () => {
    for (const chain of chains) {
      for (const text of [chain.rpc, chain.explorer]) {
        const url = new URL(text)
        expect(url.protocol).toBe("https:")
        expect(url.username + url.password + url.search + url.hash).toBe("")
      }
    }
  })

  test("Alchemy's network names are host labels", () => {
    for (const chain of chains) {
      if (chain.alchemy !== undefined) expect(chain.alchemy).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/)
    }
  })

  test("a testnet names a mainnet of the table, and a mainnet names none", () => {
    const mainnets = new Set(chains.filter((chain) => !chain.testnet).map((chain) => chain.key))
    for (const chain of chains) {
      if (chain.testnet) {
        expect(mainnets.has(chain.mainnet ?? "")).toBe(true)
      } else {
        expect(chain.mainnet).toBeUndefined()
      }
    }
  })

  test("a testnet has its mainnet's native coin and fee model", () => {
    for (const chain of chains) {
      if (!chain.testnet) continue
      const mainnet = evmChain(chain.mainnet ?? "")
      expect(chain.native).toEqual(mainnet.native)
      expect(chain.fee).toBe(mainnet.fee)
    }
  })

  test("the fee models are those the research settled", () => {
    const byModel = (model: string) =>
      chains.filter((chain) => !chain.testnet && chain.fee === model).map((chain) => chain.key)
    expect(byModel("op")).toEqual(["base", "optimism", "unichain", "celo", "world-chain", "ink", "zora"])
    expect(byModel("linea")).toEqual(["linea"])
    expect(byModel("mantle")).toEqual(["mantle"])
    expect(byModel("scroll")).toEqual(["scroll"])
  })

  test("only Celo's native coin answers as an ERC-20", () => {
    const withToken = chains.filter((chain) => chain.nativeToken !== undefined)
    expect(withToken.every((chain) => chain.key === "celo" || chain.mainnet === "celo")).toBe(true)
    expect(evmChain("celo").nativeToken).toBe("0x471EcE3750Da237f93B8E339c536989b8978a438")
  })

  test("the keys list the table in order", () => {
    expect(EVM_CHAIN_KEYS).toEqual(chains.map((chain) => chain.key) as typeof EVM_CHAIN_KEYS)
  })
})

describe("evmChain", () => {
  test("returns the entry for a key", () => {
    expect(evmChain("base").chainId).toBe(8453)
  })

  test("refuses an unknown key as invalid_argument, listing the keys", () => {
    try {
      evmChain("mainnet")
      throw new Error("expected a refusal")
    } catch (error) {
      expect(isToolError(error) && error.code).toBe("invalid_argument")
      expect((error as Error).message).toContain("ethereum, base")
    }
  })
})

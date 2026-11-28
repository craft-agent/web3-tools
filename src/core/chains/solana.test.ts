import { describe, expect, test } from "bun:test"
import { base58 } from "@scure/base"
import { isToolError } from "../errors"
import { EVM_CHAIN_KEYS } from "./evm"
import {
  SOLANA_CHAINS,
  SOLANA_CHAIN_KEYS,
  SOLANA_PROGRAMS,
  solanaChain,
  TOKEN_PROGRAMS,
  type SolanaChain,
} from "./solana"

const chains: readonly SolanaChain[] = SOLANA_CHAINS

describe("the Solana chain table", () => {
  test("holds mainnet and devnet, and no key is also an EVM chain's", () => {
    expect(chains.map((chain) => [chain.key, chain.cluster, chain.testnet])).toEqual([
      ["solana", "mainnet-beta", false],
      ["solana-devnet", "devnet", true],
    ])
    for (const key of SOLANA_CHAIN_KEYS) expect((EVM_CHAIN_KEYS as readonly string[]).includes(key)).toBe(false)
  })

  test("every endpoint and explorer is an https URL with no credentials, query or fragment", () => {
    for (const chain of chains) {
      for (const text of [chain.rpc, chain.explorer]) {
        const url = new URL(text)
        expect(url.protocol).toBe("https:")
        expect(url.username + url.password + url.search + url.hash).toBe("")
      }
    }
  })

  test("devnet names solana as its mainnet and shares its native coin", () => {
    const devnet = solanaChain("solana-devnet")
    expect(devnet.mainnet).toBe("solana")
    expect(devnet.native).toEqual(solanaChain("solana").native)
    expect(devnet.native).toEqual({ symbol: "SOL", decimals: 9 })
  })
})

describe("the Solana programs", () => {
  test("each is a base58 address of 32 bytes", () => {
    for (const program of Object.values(SOLANA_PROGRAMS)) {
      expect(base58.decode(program)).toHaveLength(32)
      expect(base58.encode(base58.decode(program))).toBe(program)
    }
  })

  test("the token programs are Token and Token-2022", () => {
    expect(TOKEN_PROGRAMS).toEqual([SOLANA_PROGRAMS.tokenProgram, SOLANA_PROGRAMS.token2022Program])
  })
})

describe("solanaChain", () => {
  test("refuses an unknown key as invalid_argument, listing the keys", () => {
    try {
      solanaChain("testnet")
      throw new Error("expected a refusal")
    } catch (error) {
      expect(isToolError(error) && error.code).toBe("invalid_argument")
      expect((error as Error).message).toContain("solana, solana-devnet")
    }
  })
})

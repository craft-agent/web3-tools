import { describe, expect, mock, test } from "bun:test"
import { SOLANA_CHAINS, type SolanaChain } from "../chains/solana"
import { HELIUS_KEY_VARIABLE } from "../rpc/providers"
import { annotations, invoke } from "../tool"
import { defineSolanaRead, web3SolanaRead } from "./read"

const CTX = { cwd: process.cwd() }
const HELIUS_KEY = "helius-key-123"

describe("web3SolanaRead", () => {
  test("publishes read class annotations", () => {
    expect(annotations(web3SolanaRead)).toEqual({
      title: "Read Solana",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("lists every cluster in table order without requests", async () => {
    const fetch = mock(async () => {
      throw new Error("No request is allowed")
    })
    const result = await invoke(defineSolanaRead({ env: {}, fetch }), { method: "chains" }, CTX)

    expect(fetch).not.toHaveBeenCalled()
    expect(result).toEqual({
      chains: SOLANA_CHAINS.map((chain: SolanaChain) => ({
        key: chain.key,
        name: chain.name,
        cluster: chain.cluster,
        native_symbol: chain.native.symbol,
        native_decimals: chain.native.decimals,
        testnet: chain.testnet,
        ...(chain.testnet ? { mainnet: chain.mainnet } : {}),
        explorer: chain.explorer,
        provider: "public",
      })),
    })
    for (const chain of result.chains!) {
      expect(Object.hasOwn(chain, "mainnet")).toBe(chain.testnet)
    }
  })

  test("selects Helius without exposing endpoints or keys", async () => {
    const result = await invoke(
      defineSolanaRead({ env: { [HELIUS_KEY_VARIABLE]: HELIUS_KEY } }),
      { method: "chains" },
      CTX,
    )

    expect(result.chains!.map((chain) => chain.provider)).toEqual(SOLANA_CHAINS.map(() => "helius"))
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(HELIUS_KEY)
    expect(serialized).not.toContain("helius-rpc.com")
    for (const chain of SOLANA_CHAINS) {
      expect(serialized).not.toContain(chain.rpc)
    }
  })

  test("refuses an unknown method", async () => {
    await expect(invoke(defineSolanaRead({ env: {} }), { method: "unknown" }, CTX)).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })

  test("refuses unknown arguments", async () => {
    await expect(
      invoke(defineSolanaRead({ env: {} }), { method: "chains", chain: "solana" }, CTX),
    ).rejects.toMatchObject({ code: "invalid_argument" })
  })
})

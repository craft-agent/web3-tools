import { describe, expect, mock, test } from "bun:test"
import { EVM_CHAINS, type EvmChain } from "../chains/evm"
import { ALCHEMY_KEY_VARIABLE } from "../rpc/providers"
import { annotations, invoke } from "../tool"
import { defineEvmRead, web3EvmRead } from "./read"

const CTX = { cwd: process.cwd() }
const ALCHEMY_KEY = "alchemy-key-123"

describe("web3EvmRead", () => {
  test("publishes read class annotations", () => {
    expect(annotations(web3EvmRead)).toEqual({
      title: "Read EVM chains",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("lists every chain in table order without requests", async () => {
    const fetch = mock(async () => {
      throw new Error("No request is allowed")
    })
    const result = await invoke(defineEvmRead({ env: {}, fetch }), { method: "chains" }, CTX)

    expect(fetch).not.toHaveBeenCalled()
    expect(result).toEqual({
      chains: EVM_CHAINS.map((chain: EvmChain) => ({
        key: chain.key,
        chain_id: chain.chainId,
        name: chain.name,
        native_symbol: chain.native.symbol,
        native_decimals: chain.native.decimals,
        testnet: chain.testnet,
        ...(chain.testnet ? { mainnet: chain.mainnet } : {}),
        explorer: chain.explorer,
        fee_model: chain.fee,
        provider: "public",
      })),
    })
    for (const chain of result.chains) {
      expect(Object.hasOwn(chain, "mainnet")).toBe(chain.testnet)
    }
  })

  test("selects Alchemy except on Scroll Sepolia without exposing endpoints or keys", async () => {
    const result = await invoke(
      defineEvmRead({ env: { [ALCHEMY_KEY_VARIABLE]: ALCHEMY_KEY } }),
      { method: "chains" },
      CTX,
    )

    for (const chain of result.chains) {
      expect(chain.provider).toBe(chain.key === "scroll-sepolia" ? "public" : "alchemy")
    }
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(ALCHEMY_KEY)
    for (const chain of EVM_CHAINS) {
      expect(serialized).not.toContain(chain.rpc)
    }
  })

  test("refuses an unknown method", async () => {
    await expect(invoke(defineEvmRead({ env: {} }), { method: "unknown" }, CTX)).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })

  test("refuses unknown arguments", async () => {
    await expect(
      invoke(defineEvmRead({ env: {} }), { method: "chains", chain: "ethereum" }, CTX),
    ).rejects.toMatchObject({ code: "invalid_argument" })
  })
})

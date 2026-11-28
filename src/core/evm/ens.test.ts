import { describe, expect, test } from "bun:test"
import { bytesToHex } from "@noble/curves/utils.js"
import { ENS_UNIVERSAL_RESOLVER_ADDRESS, evmChain } from "../chains/evm"
import { dnsEncode, ENS_SELECTORS, isEnsName, namehash, resolveEnsName } from "./ens"
import { FakeEvmChain, selectorOf } from "./testing"
import { OFFCHAIN_LOOKUP_URL } from "./testing.ens"
import { HARDHAT_ADDRESS_1 } from "./testing.sign"

function resolve(fake: FakeEvmChain, name: string, chain = "ethereum") {
  return resolveEnsName(name, evmChain(chain), { fetch: fake.fetch, env: {} })
}

describe("the selectors of the lookup", () => {
  test.each([
    ["resolve(bytes,bytes)", ENS_SELECTORS.resolve],
    ["addr(bytes32)", ENS_SELECTORS.addr],
    ["OffchainLookup(address,string[],bytes,bytes4,bytes)", ENS_SELECTORS.offchainLookup],
  ])("%s is the first four bytes of its Keccak-256", (signature, selector) => {
    expect(selector).toBe(selectorOf(signature))
  })
})

describe("names as ENS writes them", () => {
  test("namehash follows ENSIP-1", () => {
    expect(bytesToHex(namehash(""))).toBe("0".repeat(64))
    expect(bytesToHex(namehash("eth"))).toBe("93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae")
    expect(bytesToHex(namehash("foo.eth"))).toBe("de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f")
  })

  test("a name is DNS-encoded as each label after its length, then a zero", () => {
    expect(bytesToHex(dnsEncode("foo.eth"))).toBe("03666f6f0365746800")
  })

  test("a name is told from an address by its dot", () => {
    expect(isEnsName("vitalik.eth")).toBe(true)
    expect(isEnsName("0xabc.eth")).toBe(true)
    expect(isEnsName("vitalik")).toBe(false)
    expect(isEnsName("")).toBe(false)
    expect(isEnsName(HARDHAT_ADDRESS_1)).toBe(false)
    expect(isEnsName(HARDHAT_ADDRESS_1.toLowerCase())).toBe(false)
  })
})

describe("resolving a name", () => {
  test("gives the checksum address of the normalized name, from one call to the Universal Resolver", async () => {
    const fake = new FakeEvmChain("ethereum").addEnsName("raffy.eth", HARDHAT_ADDRESS_1.toLowerCase())
    expect(await resolve(fake, "RaFFy.ETH")).toEqual({ name: "raffy.eth", address: HARDHAT_ADDRESS_1 })
    expect(fake.requests).toHaveLength(1)
    const [request] = fake.requests
    expect(request).toMatchObject({ method: "eth_call", url: evmChain("ethereum").rpc })
    expect((request?.params as [{ to: string; data: string }])[0]).toMatchObject({ to: ENS_UNIVERSAL_RESOLVER_ADDRESS })
    expect((request?.params as [{ data: string }])[0].data).toStartWith(`0x${ENS_SELECTORS.resolve}`)
  })

  test("asks Ethereum for a mainnet and Sepolia for a testnet", async () => {
    const fake = new FakeEvmChain("sepolia").addEnsName("a.eth", HARDHAT_ADDRESS_1)
    await resolve(fake, "a.eth", "base")
    await resolve(fake, "a.eth", "base-sepolia")
    expect(fake.requests.map((request) => request.url)).toEqual([evmChain("ethereum").rpc, evmChain("sepolia").rpc])
  })

  test("refuses a name that needs an off-chain lookup, without fetching its URL", async () => {
    const fake = new FakeEvmChain("ethereum").addOffchainEnsName("cb.id")
    await expect(resolve(fake, "cb.id")).rejects.toMatchObject({
      code: "invalid_argument",
      message: "cb.id resolves off-chain (EIP-3668), which no tool follows; give its address instead.",
    })
    expect(fake.requests.map((request) => request.url)).toEqual([evmChain("ethereum").rpc])
    expect(JSON.stringify(fake.requests)).not.toContain(OFFCHAIN_LOOKUP_URL)
  })

  test("takes an off-chain revert from a node that gives its data in the message too", async () => {
    const fake = new FakeEvmChain("ethereum")
    fake.inject("eth_call", {
      error: { code: -32000, message: `execution reverted: 0x${ENS_SELECTORS.offchainLookup}00` },
    })
    await expect(resolve(fake, "cb.id")).rejects.toMatchObject({
      message: expect.stringContaining("resolves off-chain"),
    })
  })

  test("a name with no resolver, and one that points to nothing, have no address", async () => {
    const fake = new FakeEvmChain("ethereum").addEnsName("burn.eth", `0x${"0".repeat(40)}`)
    for (const name of ["nobody.eth", "burn.eth"]) {
      await expect(resolve(fake, name)).rejects.toMatchObject({
        code: "invalid_argument",
        message: `${name} has no address on ENS.`,
      })
    }
  })

  test("a name the normalizer refuses is invalid, with its reason and no more than the name", async () => {
    const fake = new FakeEvmChain("ethereum")
    const refused = await resolve(fake, "vita lik.eth").catch((error: unknown) => error)
    expect(refused).toMatchObject({
      code: "invalid_argument",
      message: expect.stringMatching(/^"vita lik\.eth" is not a valid ENS name: /),
    })
    await expect(resolve(fake, "a..eth")).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(resolve(fake, `${"a".repeat(300)}.eth`)).rejects.toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("(304 characters)"),
    })
    await expect(resolve(fake, `${"a".repeat(256)}.eth`)).rejects.toMatchObject({
      code: "invalid_argument",
    })
    expect(fake.requests).toHaveLength(0)
  })

  test("a read that fails, or an answer that is no resolution, is upstream_error", async () => {
    const fake = new FakeEvmChain("ethereum").addEnsName("a.eth", HARDHAT_ADDRESS_1)
    fake.inject("eth_call", { http: { status: 500, body: "Internal Server Error" } })
    await expect(resolve(fake, "a.eth")).rejects.toMatchObject({ code: "upstream_error" })
    fake.inject("eth_call", { error: { code: -32000, message: "header not found" } })
    await expect(resolve(fake, "a.eth")).rejects.toMatchObject({ code: "upstream_error" })
    fake.inject("eth_call", { result: "0x" })
    await expect(resolve(fake, "a.eth")).rejects.toMatchObject({ code: "upstream_error" })
    fake.inject("eth_call", { result: `0x${"0".repeat(128)}` })
    await expect(resolve(fake, "a.eth")).rejects.toMatchObject({ code: "invalid_argument" })
  })
})

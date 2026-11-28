import { afterEach, describe, expect, test } from "bun:test"
import { checkPin } from "../../entry/pin"
import { ENS_UNIVERSAL_RESOLVER_ADDRESS, evmChain } from "../chains/evm"
import { cleanRigs, expectRefused, makeRig, MAX_FEE, nativeArgs, tokenArgs, type SendRig } from "./send.testing"
import { OFFCHAIN_LOOKUP_URL } from "./testing.ens"
import { HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1 } from "./testing.sign"

afterEach(cleanRigs)

const NAME = "vitalik.eth"
const OTHER_ADDRESS = "0x1111111111111111111111111111111111111111"

function rigWithName(chain = "ethereum"): SendRig {
  const rig = makeRig({ chain })
  rig.fake.addEnsName(NAME, HARDHAT_ADDRESS_1)
  return rig
}

describe("a send to an ENS name", () => {
  test("goes to the address the name resolves to, and the prompt shows the name beside it", async () => {
    const rig = rigWithName()
    const args = nativeArgs({ to: NAME })
    const approval = await rig.approve(args)
    expect(approval.resources).toEqual([`from:${HARDHAT_ADDRESS_0}`, `to:${HARDHAT_ADDRESS_1}`])
    expect(approval.description?.facts.slice(0, 3)).toEqual([
      { label: "Recipient", value: HARDHAT_ADDRESS_1 },
      { label: "ENS name", value: `${NAME} resolved to ${HARDHAT_ADDRESS_1}` },
      { label: "Own wallet", value: "not one of your wallets" },
    ])

    const asked: string[] = []
    rig.ctx = { ...rig.ctx, confirm: async ({ message }) => !!asked.push(message) }
    const result = await rig.run(args)
    expect(asked).toEqual([
      `Send 1 ETH on Ethereum from ${HARDHAT_ADDRESS_0} to ${HARDHAT_ADDRESS_1} (${NAME}), with a fee of at most ${MAX_FEE} wei`,
    ])
    expect(result).toMatchObject({ outcome: "confirmed", to: HARDHAT_ADDRESS_1, ens: NAME })
    expect((await rig.rows())[0]).toMatchObject({ recipient: HARDHAT_ADDRESS_1, kind: "native" })
    expect(rig.fake.balanceOf(HARDHAT_ADDRESS_1)).toBeGreaterThan(0n)
  })

  test("is held to every refusal as the address is: a token send to a name that is the token itself", async () => {
    const rig = makeRig()
    rig.fake.addEnsName("usdc.eth", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
    await expectRefused(rig, tokenArgs({ to: "usdc.eth" }), "invalid_argument", /token's own contract/)
  })

  test("a name that resolves to the sender is a send to oneself", async () => {
    const rig = makeRig()
    rig.fake.addEnsName("me.eth", HARDHAT_ADDRESS_0)
    await expectRefused(rig, nativeArgs({ to: "me.eth" }), "invalid_argument", /sending wallet itself/)
  })

  test("a name is normalized first, and the normalized name is the one shown and returned", async () => {
    const rig = rigWithName()
    const args = nativeArgs({ to: "ViTaLiK.ETH" })
    const approval = await rig.approve(args)
    expect(approval.description?.facts[1]).toEqual({
      label: "ENS name",
      value: `${NAME} resolved to ${HARDHAT_ADDRESS_1}`,
    })
    expect((await rig.run(args)).ens).toBe(NAME)
  })

  test("an invalid name, an unknown one and one that points to the zero address are refused", async () => {
    const rig = rigWithName()
    rig.fake.addEnsName("burn.eth", `0x${"0".repeat(40)}`)
    await expectRefused(rig, nativeArgs({ to: "vita lik.eth" }), "invalid_argument", /not a valid ENS name/)
    await expectRefused(rig, nativeArgs({ to: "nobody.eth" }), "invalid_argument", /nobody\.eth has no address on ENS/)
    await expectRefused(rig, nativeArgs({ to: "burn.eth" }), "invalid_argument", /burn\.eth has no address on ENS/)
  })

  test("a name that needs an off-chain lookup is refused before anyone is asked, and no URL is fetched", async () => {
    const rig = makeRig()
    rig.fake.addOffchainEnsName("cb.id")
    await expectRefused(
      rig,
      nativeArgs({ to: "cb.id" }),
      "invalid_argument",
      /resolves off-chain \(EIP-3668\).*give its address/,
    )
    const { requests } = rig.fake
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) {
      expect(request.url).toBe(evmChain("ethereum").rpc)
      expect(request.method).toStartWith("eth_")
    }
    expect(JSON.stringify(requests)).not.toContain(OFFCHAIN_LOOKUP_URL)
  })

  test("a testnet resolves on Sepolia", async () => {
    const rig = rigWithName("sepolia")
    const result = await rig.run(nativeArgs({ chain: "sepolia", to: NAME }))
    expect(result).toMatchObject({ outcome: "confirmed", to: HARDHAT_ADDRESS_1, ens: NAME })
    const lookups = rig.fake.requests.filter((request) =>
      JSON.stringify(request.params).includes(ENS_UNIVERSAL_RESOLVER_ADDRESS),
    )
    expect(lookups.length).toBeGreaterThan(0)
    for (const lookup of lookups) expect(lookup.url).toBe(evmChain("sepolia").rpc)
  })

  test("another chain's testnet asks Sepolia and nothing else of it, and a mainnet asks Ethereum", async () => {
    for (const [chain, ensChain] of [
      ["base-sepolia", "sepolia"],
      ["base", "ethereum"],
    ] as const) {
      const rig = rigWithName(chain)
      expect((await rig.approve(nativeArgs({ chain, to: NAME }))).refused).toBeUndefined()
      const lookups = rig.fake.requests.filter((request) =>
        JSON.stringify(request.params).includes(ENS_UNIVERSAL_RESOLVER_ADDRESS),
      )
      expect(new Set(lookups.map((request) => request.url))).toEqual(new Set([evmChain(ensChain).rpc]))
      const others = rig.fake.requests.filter((request) => !lookups.includes(request))
      expect(new Set(others.map((request) => request.url))).toEqual(new Set([evmChain(chain).rpc]))
    }
  })
})

describe("a name that moves", () => {
  const stale = { code: "stale" }

  test("a name that resolves elsewhere after the prompt is stale, and nothing is sent", async () => {
    const rig = rigWithName()
    const args = nativeArgs({ to: NAME })
    const { pin } = await rig.approve(args)
    rig.fake.addEnsName(NAME, OTHER_ADDRESS)
    await expect(checkPin(rig.tool, args, rig.ctx, pin)).rejects.toMatchObject(stale)
    expect(rig.broadcasts()).toHaveLength(0)
  })

  test("a name that moves while the person answers is stale too", async () => {
    const rig = rigWithName()
    rig.ctx = {
      ...rig.ctx,
      confirm: async () => {
        rig.fake.addEnsName(NAME, OTHER_ADDRESS)
        return true
      },
    }
    await expect(rig.invoke(nativeArgs({ to: NAME }))).rejects.toMatchObject(stale)
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })
})

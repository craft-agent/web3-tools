import { afterEach, describe, expect, test } from "bun:test"
import { HYPERLIQUID_BRIDGE_ADDRESSES } from "../chains/evm"
import {
  cleanRigs,
  COLLECTION_ADDRESS,
  ERC1155_ID,
  ERC721_ID,
  expectRefused,
  makeRig,
  nftArgs,
  TOKEN_ADDRESS,
  type SendRig,
} from "./send.testing"
import { HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1 } from "./testing.sign"

afterEach(cleanRigs)

const SUPPORTS_INTERFACE = "0x01ffc9a7"

function rig721(): { rig: SendRig; owners: Map<bigint, string> } {
  const rig = makeRig()
  const { owners } = rig.fake.addErc721(COLLECTION_ADDRESS, {
    owners: { "7": HARDHAT_ADDRESS_0 },
    interfaces: [ERC721_ID],
  })
  return { rig, owners }
}

function rig1155(): SendRig {
  const rig = makeRig()
  rig.fake.addErc1155(COLLECTION_ADDRESS, { balances: [[HARDHAT_ADDRESS_0, 7n, 5n]], interfaces: [ERC1155_ID] })
  return rig
}

describe("the arguments of an NFT send", () => {
  test("a token_id needs the collection", async () => {
    const { token: _token, ...args } = nftArgs()
    await expectRefused(makeRig(), args, "invalid_argument", /token_id needs the token/)
  })

  test.each(["", "-1", "1.5", "01", "0x", "0xzz", "1e3", " 7", String(2n ** 256n), `0x1${"0".repeat(64)}`])(
    "the token id %j is refused",
    async (tokenId) => {
      await expectRefused(rig721().rig, nftArgs({ token_id: tokenId }), "invalid_argument", /token_id/)
    },
  )

  test.each(["0", "1.5", "-1", "1e3", "01", ""])("the count %j is refused", async (amount) => {
    await expectRefused(rig1155(), nftArgs({ amount }), "invalid_argument", /amount/)
  })

  test("an ERC-721 is sent one at a time", async () => {
    await expectRefused(rig721().rig, nftArgs({ amount: "2" }), "invalid_argument", /one of a kind.*must be 1/)
  })
})

describe("recipients no one should send an NFT to", () => {
  test("the zero address", async () => {
    await expectRefused(rig721().rig, nftArgs({ to: `0x${"0".repeat(40)}` }), "invalid_argument", /zero address/)
  })

  test("the sending wallet itself", async () => {
    await expectRefused(rig721().rig, nftArgs({ to: HARDHAT_ADDRESS_0.toLowerCase() }), "invalid_argument", /itself/)
  })

  test.each(HYPERLIQUID_BRIDGE_ADDRESSES)("Hyperliquid's deprecated deposit bridge $address", async ({ address }) => {
    await expectRefused(rig721().rig, nftArgs({ to: address }), "invalid_argument", /deposit bridge.*lost/)
  })

  test("the collection's own contract", async () => {
    await expectRefused(
      rig721().rig,
      nftArgs({ to: COLLECTION_ADDRESS }),
      "invalid_argument",
      /collection's own contract.*cannot return NFTs/,
    )
  })

  test("a contract that cannot take NFTs, with the chain's own reason from the fee estimate", async () => {
    const { rig } = rig721()
    rig.fake.estimateRevert = "ERC721: transfer to non ERC721Receiver implementer"
    await expectRefused(
      rig,
      nftArgs(),
      "invalid_argument",
      /would revert this transaction.*non ERC721Receiver implementer/,
    )
  })
})

describe("collections that are not collections", () => {
  test("an address without code", async () => {
    await expectRefused(makeRig(), nftArgs({ token: HARDHAT_ADDRESS_1 }), "invalid_argument", /no contract at/)
  })

  test("an ERC-20 token, which declares neither standard", async () => {
    await expectRefused(
      makeRig(),
      nftArgs({ token: TOKEN_ADDRESS }),
      "invalid_argument",
      /neither an ERC-721 nor an ERC-1155 collection/,
    )
  })

  test("a contract that answers false to both interfaces, or nothing", async () => {
    const rig = makeRig()
    rig.fake.addErc721(COLLECTION_ADDRESS, { owners: { "7": HARDHAT_ADDRESS_0 }, interfaces: [] })
    await expectRefused(rig, nftArgs(), "invalid_argument", /neither an ERC-721 nor an ERC-1155/)
    rig.fake.addContract(COLLECTION_ADDRESS)
    await expectRefused(rig, nftArgs(), "invalid_argument", /neither an ERC-721 nor an ERC-1155/)
  })

  test("a failed read of supportsInterface is an upstream error, never 'neither'", async () => {
    const { rig } = rig721()
    rig.beforeRequest = (method, params) => {
      const call = params[0] as { data?: string } | undefined
      if (method === "eth_call" && call?.data?.startsWith(SUPPORTS_INTERFACE)) {
        rig.fake.inject("eth_call", { error: { code: -32000, message: "internal error" } })
      }
    }
    const approval = await rig.approve(nftArgs())
    expect(approval.refused).toMatchObject({ code: "upstream_error" })
    expect(approval.refused?.message).not.toMatch(/neither/)
    await expect(rig.run(nftArgs())).rejects.toMatchObject({ code: "upstream_error" })
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })

  test("a failed read of the second interface, after a false first, is no 'neither' either", async () => {
    const { rig } = rig721()
    rig.fake.addErc721(COLLECTION_ADDRESS, { owners: { "7": HARDHAT_ADDRESS_0 }, interfaces: [] })
    let asked = 0
    rig.beforeRequest = (method, params) => {
      const call = params[0] as { data?: string } | undefined
      if (method === "eth_call" && call?.data?.startsWith(SUPPORTS_INTERFACE) && ++asked === 2) {
        rig.fake.inject("eth_call", { error: { code: -32000, message: "internal error" } })
      }
    }
    const approval = await rig.approve(nftArgs())
    expect(approval.refused).toMatchObject({ code: "upstream_error" })
    expect(approval.refused?.message).not.toMatch(/neither/)
  })
})

describe("what the sender holds", () => {
  test("an ERC-721 token that does not exist", async () => {
    await expectRefused(rig721().rig, nftArgs({ token_id: "8" }), "invalid_argument", /NFT #8 does not exist/)
  })

  test("an ERC-721 token of another account", async () => {
    const { rig, owners } = rig721()
    owners.set(7n, HARDHAT_ADDRESS_1.toLowerCase())
    await expectRefused(rig, nftArgs(), "invalid_argument", new RegExp(`does not own the NFT #7.*${HARDHAT_ADDRESS_1}`))
  })

  test("an ERC-1155 count above the balance, naming both", async () => {
    await expectRefused(
      rig1155(),
      nftArgs({ amount: "6" }),
      "invalid_argument",
      /holds 5 of the NFT #7.*less than the 6 to send/,
    )
    await expectRefused(rig1155(), nftArgs({ token_id: "8" }), "invalid_argument", /holds 0 of the NFT #8/)
  })

  test("a token that moved away after the prompt is refused when it runs, with nothing broadcast", async () => {
    const { rig, owners } = rig721()
    expect((await rig.approve(nftArgs())).refused).toBeUndefined()
    owners.set(7n, HARDHAT_ADDRESS_1.toLowerCase())
    await expect(rig.invoke(nftArgs())).rejects.toMatchObject({ code: "invalid_argument" })
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })
})

describe("the fee of an NFT send", () => {
  test("is paid in the native coin: a wallet that cannot cover max_fee is refused", async () => {
    const { rig } = rig721()
    rig.fake.setBalance(HARDHAT_ADDRESS_0, 10n ** 14n)
    await expectRefused(rig, nftArgs(), "invalid_argument", /holds 100000000000000 wei.*Give a smaller max_fee/)
  })

  test("a max_fee below what the network asks now is refused, with one that leaves room", async () => {
    const { rig } = rig721()
    await expectRefused(rig, nftArgs({ max_fee: "1000" }), "invalid_argument", /max_fee 1000 wei is below the/)
  })
})

describe("earlier writes and the hourly cap", () => {
  test("an NFT send while the node holds the last one is refused as stale, naming its hash", async () => {
    const { rig } = rig721()
    rig.fake.failSend({ transport: "timeout", accepted: true })
    rig.mineAtMs = undefined
    const first = await rig.run(nftArgs())
    expect(first.outcome).toBe("pending")
    const approval = await rig.approve(nftArgs())
    expect(approval.refused).toMatchObject({ code: "stale" })
    expect(approval.refused?.message).toContain(first.hash)
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("sends_per_hour counts an NFT send like any other", async () => {
    const rig = makeRig({ options: { sends_per_hour: 1 } })
    rig.fake.addErc1155(COLLECTION_ADDRESS, { balances: [[HARDHAT_ADDRESS_0, 7n, 5n]], interfaces: [ERC1155_ID] })
    expect((await rig.run(nftArgs())).outcome).toBe("confirmed")
    const approval = await rig.approve(nftArgs())
    expect(approval.refused).toMatchObject({ code: "rate_limited" })
    expect(rig.broadcasts()).toHaveLength(1)
  })
})

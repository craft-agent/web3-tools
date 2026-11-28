import { afterEach, describe, expect, test } from "bun:test"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { HARDHAT_KEY_0 } from "../signer/testing"
import { associatedTokenAddress } from "./address"
import {
  BOB,
  cleanRigs,
  expectRefused,
  LAMPORTS_PER_SOL,
  MAIN_ADDRESS,
  makeRig,
  MINT,
  solArgs,
  tokenArgs,
} from "./send.testing"
import { testAddress } from "./testing"

afterEach(cleanRigs)

describe("the arguments of a send", () => {
  test("a recipient that is not an address is refused", async () => {
    await expectRefused(makeRig(), solArgs({ to: "bob" }), "invalid_argument", /not a Solana address/)
  })

  test("a mint that is not an address is refused", async () => {
    await expectRefused(makeRig(), tokenArgs({ mint: "usdc" }), "invalid_argument", /mint.*not a Solana address/)
  })

  test("an amount more precise than the coin or the token is refused, never rounded", async () => {
    await expectRefused(makeRig(), solArgs({ amount: "0.0000000001" }), "invalid_argument", /9 decimals/)
    await expectRefused(makeRig(), tokenArgs({ amount: "0.0000001" }), "invalid_argument", /6 decimals/)
  })

  test("an amount or a max_fee that is not plain digits is refused", async () => {
    await expectRefused(makeRig(), solArgs({ amount: "1e3" }), "invalid_argument", /amount/)
    await expectRefused(makeRig(), solArgs({ amount: "0" }), "invalid_argument", /more than 0/)
    await expectRefused(makeRig(), solArgs({ max_fee: "0.5" }), "invalid_argument", /max_fee/)
  })

  test("an amount beyond a u64 is refused", async () => {
    await expectRefused(makeRig(), solArgs({ amount: "18446744074" }), "invalid_argument", /2\^64/)
  })

  test("a sender with no key is refused before any request to the cluster", async () => {
    const rig = makeRig()
    const approval = await rig.approve(solArgs({ account: "ghost" }))
    expect(approval.refused).toBeDefined()
    expect(approval.resources).toBeUndefined()
    expect(rig.fake.requests).toHaveLength(0)
  })

  test("a wallet that holds an EVM key cannot send on Solana", async () => {
    const rig = makeRig({ wallets: { WEB3_TOOLS_WALLET_MAIN: HARDHAT_KEY_0 } })
    await expectRefused(rig, solArgs(), "invalid_argument", /cannot act on Solana/)
    expect(rig.fake.requests).toHaveLength(0)
  })

  test("with several wallets and no account the choice is refused, naming them", async () => {
    const rig = makeRig()
    const { account: _account, ...args } = solArgs()
    await expectRefused(rig, args, "invalid_argument", /main, savings/)
  })

  test("an unknown cluster or argument is refused by the schema", async () => {
    const rig = makeRig()
    await expect(rig.invoke(solArgs({ chain: "ethereum" }))).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(rig.invoke(solArgs({ token_id: "1" }))).rejects.toMatchObject({ code: "invalid_argument" })
  })
})

describe("recipients no one should send to", () => {
  const tokenProgram = SOLANA_PROGRAMS.tokenProgram

  test("the sending wallet itself", async () => {
    await expectRefused(makeRig(), solArgs({ to: MAIN_ADDRESS }), "invalid_argument", /sending wallet itself/)
  })

  test("a program", async () => {
    const rig = makeRig()
    rig.fake.setAccount(BOB, { owner: SOLANA_PROGRAMS.associatedTokenProgram, executable: true, space: 36 })
    await expectRefused(rig, solArgs(), "invalid_argument", /is a program/)
  })

  test("a token account, whose owner's wallet is asked for", async () => {
    const rig = makeRig()
    rig.fake.addTokenAccount(BOB, MINT, testAddress(5))
    await expectRefused(rig, tokenArgs(), "invalid_argument", /token account; give the owner's wallet address/)
    await expectRefused(rig, solArgs(), "invalid_argument", /token account; give the owner's wallet address/)
  })

  test("a token mint", async () => {
    const rig = makeRig()
    await expectRefused(rig, solArgs({ to: MINT }), "invalid_argument", /token mint; give the owner's wallet address/)
  })

  test("a nonce account", async () => {
    const rig = makeRig()
    rig.fake.setAccount(BOB, { space: 80 })
    await expectRefused(rig, solArgs(), "invalid_argument", /nonce account/)
  })

  test("an account another program owns", async () => {
    const rig = makeRig()
    rig.fake.setAccount(BOB, { owner: SOLANA_PROGRAMS.tokenMetadataProgram, space: 10 })
    await expectRefused(rig, solArgs(), "invalid_argument", /another program owns/)
  })

  test("an address no key can own and no account is at, for SOL or a token", async () => {
    const rig = makeRig()
    const offCurve = associatedTokenAddress(BOB, MINT, tokenProgram)
    await expectRefused(rig, solArgs({ to: offCurve }), "invalid_argument", /not an address a key can own/)
    await expectRefused(rig, tokenArgs({ to: offCurve }), "invalid_argument", /not an address a key can own/)
  })

  test("SOL to a new account that would hold less than the rent-exempt minimum", async () => {
    const rig = makeRig()
    const message = /must hold at least 650240 lamports.*send at least that/
    await expectRefused(rig, solArgs({ amount: "0.0005" }), "invalid_argument", message)
    expect((await rig.run(solArgs({ amount: "0.00065024" }))).outcome).toBe("confirmed")
    expect(rig.fake.balanceOf(BOB)).toBe(650_240n)
  })
})

describe("the sender's SOL", () => {
  test("a SOL send never leaves the wallet below the rent-exempt minimum, and says how much it may send", async () => {
    const rig = makeRig()
    const message = /would leave it below that\. Send at most 9999249760 lamports \(9\.99924976 SOL\)/
    await expectRefused(rig, solArgs({ amount: "10" }), "invalid_argument", message)
    await expectRefused(rig, solArgs({ amount: "9.99924977" }), "invalid_argument", message)
    expect((await rig.run(solArgs({ amount: "9.99924976" }))).outcome).toBe("confirmed")
    expect(rig.fake.balanceOf(MAIN_ADDRESS)).toBeGreaterThanOrEqual(650_240n)
  })

  test("a wallet that cannot pay max_fee and stay open is told to add SOL", async () => {
    const rig = makeRig()
    rig.fake.setBalance(MAIN_ADDRESS, 700_000n)
    rig.fake.setBalance(BOB, LAMPORTS_PER_SOL)
    await expectRefused(
      rig,
      solArgs({ amount: "0.000001" }),
      "invalid_argument",
      /Not even max_fee alone leaves it enough/,
    )
  })

  test("a token send leaves the wallet its rent-exempt minimum too, the created account's rent included", async () => {
    const rig = makeRig()
    const needed = BigInt(100_000) + rig.fake.rentFor(165) + rig.fake.rentFor(0)
    rig.fake.setBalance(MAIN_ADDRESS, needed - 1n)
    const message = /would leave it below that\. Add SOL or give a smaller max_fee/
    await expectRefused(rig, tokenArgs(), "invalid_argument", message)
    rig.fake.setBalance(MAIN_ADDRESS, needed)
    expect((await rig.run(tokenArgs())).outcome).toBe("confirmed")
  })

  test("a token send to an existing token account needs no rent for one", async () => {
    const rig = makeRig()
    rig.fake.addAssociatedTokenAccount(BOB, MINT)
    rig.fake.setBalance(MAIN_ADDRESS, 100_000n + rig.fake.rentFor(0))
    expect((await rig.run(tokenArgs())).outcome).toBe("confirmed")
  })

  test("the rent comes from the cluster's own simulation of the token account the send creates", async () => {
    const rig = makeRig()
    const created = associatedTokenAddress(BOB, MINT, SOLANA_PROGRAMS.tokenProgram)
    await rig.approve(tokenArgs())
    const [config] = rig.fake.requestsOf("simulateTransaction").map(([, options]) => options)
    expect(config).toMatchObject({ accounts: { addresses: [created], encoding: "base64" } })
  })
})

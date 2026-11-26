import { describe, expect, test } from "bun:test"
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js"
import {
  evmAddress,
  evmSecretsOf,
  phraseSeed,
  slip10Ed25519,
  solanaAddress,
  solanaSeedOf,
  toChecksumAddress,
} from "./derive"
import { ABANDON_PHRASE, HARDHAT_KEY_0, HARDHAT_PHRASE } from "./testing"

/** The EIP-55 examples: all capitals, all lower case, and mixed case. */
const EIP55 = [
  "0x52908400098527886E0F7030069857D2E4169EE7",
  "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
  "0xde709f2102306220921060314715629080e2fb77",
  "0x27b1fdb04752bbc536007a920d24acb045561c26",
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
]

/** SLIP-0010 test vector 1 for ed25519: the seed, and the private key at each hardened path. */
const SLIP10_SEED = hexToBytes("000102030405060708090a0b0c0d0e0f")
const SLIP10_VECTOR_1: { path: number[]; private: string }[] = [
  { path: [], private: "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7" },
  { path: [0], private: "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3" },
  { path: [0, 1], private: "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2" },
  { path: [0, 1, 2], private: "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9" },
  { path: [0, 1, 2, 2], private: "30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662" },
  { path: [0, 1, 2, 2, 1000000000], private: "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793" },
]

describe("toChecksumAddress", () => {
  test("gives the EIP-55 form of each example", () => {
    for (const address of EIP55) {
      expect(toChecksumAddress(hexToBytes(address.slice(2).toLowerCase()))).toBe(address)
    }
  })

  test("refuses bytes that are not an address", () => {
    expect(() => toChecksumAddress(new Uint8Array(19))).toThrow("20 bytes")
  })
})

describe("evmAddress", () => {
  test("is Hardhat's first account for its first key", () => {
    expect(evmAddress(hexToBytes(HARDHAT_KEY_0.slice(2)))).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  })
})

describe("slip10Ed25519", () => {
  test.each(SLIP10_VECTOR_1)("matches SLIP-0010 test vector 1 at path $path", ({ path, private: expected }) => {
    expect(bytesToHex(slip10Ed25519(SLIP10_SEED, path))).toBe(expected)
  })

  test("refuses an index that is not a whole number below 2^31", () => {
    for (const index of [-1, 1.5, 2 ** 31, Number.NaN]) {
      expect(() => slip10Ed25519(SLIP10_SEED, [index])).toThrow("whole number")
    }
  })

  test("leaves the seed as it was", () => {
    const seed = new Uint8Array(SLIP10_SEED)
    slip10Ed25519(seed, [0, 1])
    expect(seed).toEqual(SLIP10_SEED)
  })
})

describe("phrase accounts", () => {
  test("Hardhat's phrase opens the accounts of Hardhat and Phantom", () => {
    const seed = phraseSeed(HARDHAT_PHRASE)
    expect(evmSecretsOf(seed, [0, 1]).map(evmAddress)).toEqual([
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    ])
    expect([0, 1].map((index) => solanaAddress(solanaSeedOf(seed, index)))).toEqual([
      "oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96",
      "AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD",
    ])
  })

  test("the abandon phrase opens the known first accounts", () => {
    const seed = phraseSeed(ABANDON_PHRASE)
    expect(evmAddress(evmSecretsOf(seed, [0])[0])).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94")
    expect(solanaAddress(solanaSeedOf(seed, 0))).toBe("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk")
  })

  test("derives a secret per index and none for no index", () => {
    const seed = phraseSeed(HARDHAT_PHRASE)
    expect(evmSecretsOf(seed, [])).toEqual([])
    const [first, second] = evmSecretsOf(seed, [0, 1])
    expect(bytesToHex(first)).toBe(HARDHAT_KEY_0.slice(2))
    expect(second).not.toEqual(first)
  })

  test("leaves the seed as it was", () => {
    const seed = phraseSeed(HARDHAT_PHRASE)
    const copy = new Uint8Array(seed)
    evmSecretsOf(seed, [0])
    solanaSeedOf(seed, 0)
    expect(seed).toEqual(copy)
  })
})

import { describe, expect, test } from "bun:test"
import { MASK, maskDeep, maskSecrets } from "./mask"

describe("maskSecrets", () => {
  test("masks every occurrence, plain and URL-encoded", () => {
    expect(maskSecrets("a/b+c and a%2Fb%2Bc and a/b+c", ["a/b+c"])).toBe(`${MASK} and ${MASK} and ${MASK}`)
  })

  test("masks the longest secret first, so one inside another does not leave a tail", () => {
    expect(maskSecrets("key abcdef", ["abc", "abcdef"])).toBe(`key ${MASK}`)
    expect(maskSecrets("key abcdef", ["abcdef", "abc"])).toBe(`key ${MASK}`)
  })

  test("a secret is matched literally, not as a pattern", () => {
    expect(maskSecrets("x.y and xzy", ["x.y"])).toBe(`${MASK} and xzy`)
  })

  test("ignores empty secrets and leaves text without a secret alone", () => {
    expect(maskSecrets("nothing here", ["", "secret"])).toBe("nothing here")
    expect(maskSecrets("nothing here", [])).toBe("nothing here")
  })

  test("a secret that looks like the mask does not eat the mask", () => {
    expect(maskSecrets("a secret and mask", ["secret", "mask"])).toBe(`a ${MASK} and ${MASK}`)
  })
})

describe("maskDeep", () => {
  const secrets = ["s3cret"]

  test("masks strings, keys, and what arrays and objects hold", () => {
    const value = { s3cret: "x", list: ["a s3cret", 1, null, { deep: "s3cret!" }], n: 2, ok: true }

    expect(maskDeep<unknown>(value, secrets)).toEqual({
      [MASK]: "x",
      list: [`a ${MASK}`, 1, null, { deep: `${MASK}!` }],
      n: 2,
      ok: true,
    })
  })

  test("returns a copy and leaves the input alone", () => {
    const value = { a: ["s3cret"] }
    const copy = maskDeep(value, secrets)

    expect(copy).not.toBe(value)
    expect(value.a[0]).toBe("s3cret")
  })

  test("returns the value itself when there are no secrets", () => {
    const value = { a: "s3cret" }

    expect(maskDeep(value, [])).toBe(value)
  })

  test("leaves a value that is not a string, array or plain object as it is", () => {
    const date = new Date(0)

    expect(maskDeep(date, secrets)).toBe(date)
    expect(maskDeep(undefined, secrets)).toBeUndefined()
  })
})

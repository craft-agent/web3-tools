/** What replaces a provider key in any text a client returns or throws. */
export const MASK = "[masked]"

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g

/** Whether a value is an object made by a literal or `JSON.parse`, as opposed to an array, a class instance or `null`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function masker(secrets: readonly string[]): ((text: string) => string) | undefined {
  const forms = new Set<string>()
  for (const secret of secrets) {
    if (secret.length === 0) continue
    forms.add(secret)
    forms.add(encodeURIComponent(secret))
  }
  if (forms.size === 0) return undefined
  const pattern = new RegExp(
    [...forms]
      .sort((a, b) => b.length - a.length)
      .map((form) => form.replace(REGEXP_SPECIALS, "\\$&"))
      .join("|"),
    "g",
  )
  return (text) => text.replace(pattern, MASK)
}

/**
 * Replaces every occurrence of each secret, and of its URL-encoded form, with `[masked]`.
 * One pass with the longest forms first, so a secret that contains another is masked whole.
 */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  return masker(secrets)?.(text) ?? text
}

/** A copy of `value` with every string, object keys included, masked; arrays and plain objects are walked. */
export function maskDeep<T>(value: T, secrets: readonly string[]): T {
  const mask = masker(secrets)
  return mask ? (walk(value, mask) as T) : value
}

function walk(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === "string") return mask(value)
  if (Array.isArray(value)) return value.map((item: unknown) => walk(item, mask))
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [mask(key), walk(item, mask)]))
  }
  return value
}

import { isToolError, ToolError } from "../errors"
import { keyMaterial } from "./keys"
import type { WalletKey } from "./keys"

type Material = ReturnType<typeof keyMaterial>

/**
 * Runs `work` on a copy of the key's material and zeroes the copy after. A
 * failure that is not a refusal is replaced by a fixed message naming `step`
 * ("deriving the accounts of", "signing for"), since it may hold the material.
 */
export function holding<T>(key: WalletKey, label: string, step: string, work: (material: Material) => T): T {
  const material = keyMaterial(key)
  try {
    return work(material)
  } catch (error) {
    if (isToolError(error)) throw error
    throw new ToolError("internal_error", `The signer failed while ${step} wallet "${label}".`)
  } finally {
    material.secret?.fill(0)
  }
}

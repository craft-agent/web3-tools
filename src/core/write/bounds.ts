/** The separator of the paths the `asset` and `recipient` bounds are measured as. */
export const PATH_SEPARATOR = "/"

const DOUBLE_BYTES = 8

/** The smallest double above a positive, finite `value`. */
function nextUp(value: number): number {
  const view = new DataView(new ArrayBuffer(DOUBLE_BYTES))
  view.setFloat64(0, value)
  view.setBigUint64(0, view.getBigUint64(0) + 1n)
  return view.getFloat64(0)
}

/**
 * `value` as a number that is never below it: exact up to 2^53, above that rounded up to the next double, since
 * a bound that measured a call below its true amount would let it through a grant it exceeds.
 */
export function ceilToNumber(value: bigint): number {
  const nearest = Number(value)
  return BigInt(nearest) >= value ? nearest : nextUp(nearest)
}

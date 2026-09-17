import { assert } from "@effect/vitest"
import { Cause, Predicate } from "effect"
import type { Exit } from "effect"

const failureTags = <E>(cause: Cause.Cause<E>): ReadonlyArray<string> =>
  cause.reasons.map((reason) =>
    reason._tag === "Fail" && typeof reason.error === "object" && reason.error !== null && "_tag" in reason.error
      ? String(reason.error._tag)
      : reason._tag,
  )

/** The exit is a failure whose error has `tag`. Returns that error for further assertions. */
export const extractFailureByTag = <A, E, Tag extends string>(exit: Exit.Exit<A, E>, tag: Tag): Extract<E, { readonly _tag: Tag }> => {
  assert.strictEqual(exit._tag, "Failure", `expected a failure with tag ${tag}, got a success`)
  if (exit._tag !== "Failure") {
    throw new Error("unreachable")
  }
  const failure = Cause.findErrorOption(exit.cause)
  assert.isTrue(failure._tag === "Some", `expected a failure with tag ${tag}, got ${failureTags(exit.cause).join(", ")}`)
  if (failure._tag !== "Some") {
    throw new Error("unreachable")
  }
  const error: unknown = failure.value
  assert.isTrue(
    Predicate.hasProperty(error, "_tag") && error._tag === tag,
    `expected a failure with tag ${tag}, got ${failureTags(exit.cause).join(", ")}`,
  )
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tag was checked above
  return failure.value as Extract<E, { readonly _tag: Tag }>
}

export const assertFailsWithTag = <A, E>(exit: Exit.Exit<A, E>, tag: string): void => {
  extractFailureByTag(exit, tag)
}

/** The exit is a defect (a die), not a typed failure. */
export const assertDies = <A, E>(exit: Exit.Exit<A, E>): void => {
  assert.strictEqual(exit._tag, "Failure", "expected a defect, got a success")
  if (exit._tag !== "Failure") {
    throw new Error("unreachable")
  }
  assert.isTrue(Cause.hasDies(exit.cause), `expected a defect, got ${failureTags(exit.cause).join(", ")}`)
}

import { Schema } from "effect"

type Fields = Schema.Struct.Fields
type Cases = Record<string, Fields>

/** A `TaggedStruct` schema that is also callable: `Foo({ count: 1 })` instead of `Foo.make({ count: 1 })`. */
export type Callable<Tag extends string, F extends Fields> = Schema.TaggedStruct<Tag, F> &
  (keyof F extends never
    ? () => Schema.TaggedStruct<Tag, F>["Type"]
    : (value: Parameters<Schema.TaggedStruct<Tag, F>["make"]>[0]) => Schema.TaggedStruct<Tag, F>["Type"])

/** A tagged union schema with one callable constructor per variant and an exhaustive `match`. */
export type TaggedUnion<C extends Cases> = Schema.TaggedUnion<{
  readonly [Tag in keyof C & string]: Schema.TaggedStruct<Tag, C[Tag]>
}> & { readonly [Tag in keyof C & string]: Callable<Tag, C[Tag]> }

const makeCallable = (tag: string, fields: Fields) => {
  const struct = Schema.TaggedStruct(tag, fields)
  return new Proxy(function () {}, {
    apply: (_target, _this, args: ReadonlyArray<unknown>) => struct.make((args[0] ?? {}) as never),
    get: (_target, property) => Reflect.get(struct, property),
    has: (_target, property) => Reflect.has(struct, property),
    getPrototypeOf: () => Reflect.getPrototypeOf(struct),
  })
}

/**
 * Declare every variant of a tagged union in one object. Each key becomes the `_tag`,
 * each value lists that variant's fields. The result is a Schema, a namespace of
 * constructors, and an exhaustive `match`.
 *
 *   const Turn = defineTaggedUnion({ Idle: {}, Streaming: { id: Schema.Number } })
 *   Turn.Idle()                       // { _tag: "Idle" }
 *   Turn.match(turn, { Idle: ..., Streaming: ... })
 */
export const defineTaggedUnion = <const C extends Cases>(cases: C): TaggedUnion<C> => {
  const union = Schema.TaggedUnion(cases)
  const conflicts = Object.keys(cases).filter((tag) => Reflect.has(union, tag))
  if (conflicts.length > 0) {
    throw new Error(`Variant names conflict with union properties: ${conflicts.join(", ")}`)
  }
  const constructors = Object.fromEntries(
    Object.entries(cases).map(([tag, fields]) => [tag, makeCallable(tag, fields)]),
  )
  return Object.assign(union, constructors) as unknown as TaggedUnion<C>
}

/** Messages are facts, named in the past tense. Same shape as `defineTaggedUnion`, kept separate for intent. */
export const defineMessageUnion = defineTaggedUnion

import type { Command } from "./command"
import type { Return, Update } from "./program"

/**
 * Story tests: drive `update` with Messages and assert on the Model, without running any
 * Effect. Commands are data, so they are matched by name and "resolved" by feeding the
 * Message they would have produced back through `update`.
 *
 *   story(update,
 *     given(init().model),
 *     message(Message.cases.ClickedResetAfterDelay.make({})),
 *     expectCommands(DelayReset),
 *     resolve(DelayReset, Message.cases.CompletedDelayReset.make({})),
 *     model((m) => expect(m.count).toBe(0)))
 */
export interface Simulation<Model, Msg, R> {
  readonly model: Model
  readonly commands: ReadonlyArray<Command<Msg, R>>
}

/** Method syntax on purpose: it keeps steps assignable when TypeScript infers a narrower Msg from one step's argument. */
export interface Step<Model, Msg, R> {
  // oxlint-disable-next-line typescript/method-signature-style -- see above
  run(simulation: Simulation<Model, Msg, R>, update: Update<Model, Msg, R>): Simulation<Model, Msg, R>
}

const step = <Model, Msg, R>(run: Step<Model, Msg, R>["run"]): Step<Model, Msg, R> => ({ run })

interface Named {
  readonly name: string
}

const names = (commands: ReadonlyArray<Named>) =>
  commands
    .map((c) => c.name)
    .toSorted()
    .join(", ") || "(none)"

export const story = <Model, Msg, R>(
  update: Update<Model, Msg, R>,
  ...steps: ReadonlyArray<Step<Model, Msg, R>>
): Simulation<Model, Msg, R> => {
  const final = steps.reduce<Simulation<Model, Msg, R>>((simulation, current) => current.run(simulation, update), {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the first step is `given` or `booted`, which supplies the Model
    model: undefined as never,
    commands: [],
  })
  if (final.commands.length > 0) {
    throw new Error(`Story ended with unresolved commands: ${names(final.commands)}`)
  }
  return final
}

export const given = <Model, Msg, R>(model: Model): Step<Model, Msg, R> => step(() => ({ model, commands: [] }))

/** Start from what `init` returned: its Model, with its commands pending. */
export const booted = <Model, Msg, R>(initial: Return<Model, Msg, R>): Step<Model, Msg, R> =>
  step(() => ({ model: initial.model, commands: initial.commands ?? [] }))

export const message = <Model, Msg, R>(msg: Msg): Step<Model, Msg, R> =>
  step((simulation, update) => {
    if (simulation.commands.length > 0) {
      throw new Error(`Resolve pending commands before the next message: ${names(simulation.commands)}`)
    }
    const next = update(simulation.model, msg)
    return { model: next.model, commands: next.commands ?? [] }
  })

/**
 * A Message that arrives while commands are still pending, leaving them pending. Use it to say
 * "this happened before that command came back"; `message` refuses so the interleaving is explicit.
 */
export const meanwhile = <Model, Msg, R>(msg: Msg): Step<Model, Msg, R> =>
  step((simulation, update) => {
    const next = update(simulation.model, msg)
    return { model: next.model, commands: [...simulation.commands, ...(next.commands ?? [])] }
  })

export const model = <Model, Msg, R>(assert: (model: Model) => void): Step<Model, Msg, R> =>
  step((simulation) => {
    assert(simulation.model)
    return simulation
  })

/** Exact, order-independent match of pending commands by name. */
export const expectCommands = <Model, Msg, R>(...definitions: ReadonlyArray<Named>): Step<Model, Msg, R> =>
  step((simulation) => {
    const expected = names(definitions)
    const actual = names(simulation.commands)
    if (expected !== actual) {
      throw new Error(`Expected commands [${expected}] but found [${actual}]`)
    }
    return simulation
  })

export const expectNoCommands = <Model, Msg, R>(): Step<Model, Msg, R> => expectCommands()

/** Feed one Message from a pending streaming command through `update`, leaving the command pending. */
export const emit = <Model, Msg, R>(definition: Named, result: Msg): Step<Model, Msg, R> =>
  step((simulation, update) => {
    if (!simulation.commands.some((c) => c.name === definition.name)) {
      throw new Error(`No pending command named ${definition.name}; pending: ${names(simulation.commands)}`)
    }
    const next = update(simulation.model, result)
    return { model: next.model, commands: [...simulation.commands, ...(next.commands ?? [])] }
  })

/** Drop the first pending command with this name and feed its result Message through `update`. */
export const resolve = <Model, Msg, R>(definition: Named, result: Msg): Step<Model, Msg, R> =>
  step((simulation, update) => {
    const index = simulation.commands.findIndex((c) => c.name === definition.name)
    if (index === -1) {
      throw new Error(`No pending command named ${definition.name}; pending: ${names(simulation.commands)}`)
    }
    const remaining = simulation.commands.filter((_, i) => i !== index)
    const next = update(simulation.model, result)
    return { model: next.model, commands: [...remaining, ...(next.commands ?? [])] }
  })

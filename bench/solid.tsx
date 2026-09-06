import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"

const App = () => {
  const [count, setCount] = createSignal(0)
  const renderer = useRenderer()

  // End the benchmark immediately after the first completed native frame.
  renderer.once("frame", () => process.exit(0))

  useKeyboard((key) => {
    if (key.name === "q") renderer.destroy()
    if (key.name === "left") setCount((count) => count - 1)
    if (key.name === "right") setCount((count) => count + 1)
  })

  return (
    <box border padding={2} flexDirection="column">
      <text>Hello, OpenTUI!</text>
      <text>Count {count()}</text>
      <text fg="#888">left/right change | q quit</text>
    </box>
  )
}

render(App)

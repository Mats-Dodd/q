import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"

const App = () => {
  const [count, setCount] = createSignal(0)
  const renderer = useRenderer()

  renderer.once("frame", () => process.exit(0))

  useKeyboard((key) => {
    if (key.name === "q") renderer.destroy()
    if (key.name === "left") setCount((count) => count - 1)
    if (key.name === "right") setCount((count) => count + 1)
  })

  return (
    <box
      width={42}
      height={9}
      backgroundColor="#1131E9"
      alignItems="center"
      justifyContent="center"
    >
      <box
        width={38}
        height={7}
        backgroundColor="#2947F0"
        padding={1}
        flexDirection="column"
        gap={1}
        alignItems="center"
      >
        <text fg="#DCE3FF">Hello, OpenTUI!</text>
        <text fg="#FFFFFF">Count  {count()}</text>
        <text fg="#AEBBFF">left/right change | q quit</text>
      </box>
    </box>
  )
}

render(App, {
  exitOnCtrlC: true,
  backgroundColor: "#1131E9",
})

import { render, Box, Text, useStdout } from "ink";
import { useState } from "react";
import { LineEditor } from "./editor.ts";
import { PromptInput } from "./components/PromptInput.tsx";
import { Rule } from "./components/Rule.tsx";

function App() {
  const [editor] = useState(() => new LineEditor());
  const [history, setHistory] = useState<string[]>([]);
  const { stdout } = useStdout();
  const w = stdout?.columns ?? 80;

  return (
    <>
      {history.map((h, i) => <Text key={i}>{h}</Text>)}
      <Box flexDirection="column">
        <Rule title="harness" width={w} />
        <PromptInput
          editor={editor}
          onSubmit={(text) => setHistory(prev => [...prev, "> " + text])}
        />
        <Rule width={w} />
      </Box>
    </>
  );
}

render(<App />);

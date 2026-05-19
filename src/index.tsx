import { render, Box, Text } from "ink";
import { useEffect } from "react";

function App({ onExit }: { onExit: () => void }) {
  useEffect(() => {
    const t = setTimeout(onExit, 2000);
    return () => clearTimeout(t);
  }, [onExit]);
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text>octmux — Ink hello</Text>
    </Box>
  );
}

const { unmount, waitUntilExit } = render(<App onExit={() => unmount()} />);
await waitUntilExit();

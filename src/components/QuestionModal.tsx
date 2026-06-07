import { Box, Text } from "ink";

type Question = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
};

type Props = {
  questions: Question[];
  currentSubIdx: number;
};

export function QuestionModal({ questions, currentSubIdx }: Props) {
  const q = questions[currentSubIdx] ?? questions[0];
  if (!q) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#83a598" paddingX={1}>
      <Text color="#83a598" bold>
        {`▶ Question ${currentSubIdx + 1}/${questions.length}${q.header ? ` — ${q.header}` : ""}`}
      </Text>
      <Box marginTop={1}>
        <Text bold color="#ebdbb2">{q.question}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {q.options.map((o, i) => (
          <Text key={i}>
            <Text color="#fabd2f" bold>{`  ${i + 1}.`}</Text>
            <Text>{` ${o.label}`}</Text>
            <Text dimColor>{` — ${o.description}`}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Press <Text color="#fabd2f" bold>{`1–${q.options.length}`}</Text> to answer
          {questions.length > 1 ? ` · ${questions.length - currentSubIdx - 1} more after this` : ""}
        </Text>
      </Box>
    </Box>
  );
}
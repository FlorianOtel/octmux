import { Box, Text, useInput } from "ink";
import { useState } from "react";

type Question = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
};

type Props = {
  questions: Question[];
  onAnswer: (answers: string[][]) => void;
};

export function QuestionModal({ questions, onAnswer }: Props) {
  const [qIdx, setQIdx] = useState(0);
  const [answers, setAnswers] = useState<string[][]>([]);

  const q = questions[qIdx];

  useInput((input) => {
    const n = parseInt(input, 10);
    if (isNaN(n) || n < 1 || n > q.options.length) return;
    const chosen = [q.options[n - 1].label];
    const next = [...answers, chosen];
    if (qIdx < questions.length - 1) {
      setAnswers(next);
      setQIdx(qIdx + 1);
    } else {
      onAnswer(next);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#83a598" paddingX={1}>
      <Text color="#83a598" bold>
        {`▶ Question ${qIdx + 1}/${questions.length}${q.header ? ` — ${q.header}` : ""}`}
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
          {questions.length > 1 ? ` · ${questions.length - qIdx - 1} more after this` : ""}
        </Text>
      </Box>
    </Box>
  );
}

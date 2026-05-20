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
    <Box flexDirection="column">
      <Text bold>{q.question}</Text>
      {q.options.map((o, i) => (
        <Text key={i} dimColor>  {i + 1}. {o.label} — {o.description}</Text>
      ))}
    </Box>
  );
}

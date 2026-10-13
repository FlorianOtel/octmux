import { Box, Text } from "ink";
import type { FormField } from "../events.ts";
import { answerInstruction, isLastField } from "./form-modal-logic.ts";

type Props = {
  /** Form title, shown in the header. */
  title: string;
  /** All fields of the form, answered one at a time in order. */
  fields: FormField[];
  /** 0-based index of the field currently being answered. */
  currentFieldIdx: number;
  /** Text typed so far for the current field. Input handling lives in app.tsx. */
  draft: string;
};

/**
 * Presentational modal for a v2 form (question-style request). It shows one field at
 * a time and does no input handling itself: app.tsx owns the draft and calls
 * `answerForKey` / `buildAnswer` from `form-modal-logic.ts`, mirroring how
 * `QuestionModal` is driven by `handleQuestion`.
 */
export function FormModal({ title, fields, currentFieldIdx, draft }: Props) {
  const field = fields[currentFieldIdx];
  if (!field) return null;

  const options = field.options ?? [];
  const hasOptions = options.length > 0;
  const isBoolean = field.type === "boolean";
  const isLast = isLastField(currentFieldIdx, fields);

  // Footer instruction, phrased per field type by the pure helper in form-modal-logic.ts.
  const answerHint = answerInstruction(field);
  const submitHint = isLast ? "submit form" : "submit field";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#83a598" paddingX={1}>
      <Text color="#83a598" bold>
        {`▶ Form — ${title} (field ${currentFieldIdx + 1}/${fields.length})`}
      </Text>
      <Box marginTop={1}>
        <Text bold color="#ebdbb2">{field.title}</Text>
      </Box>
      {field.description ? <Text dimColor>{field.description}</Text> : null}

      {hasOptions ? (
        <Box flexDirection="column" marginTop={1}>
          {options.map((o, i) => (
            <Text key={i}>
              <Text color="#fabd2f" bold>{`  ${i + 1}.`}</Text>
              <Text>{` ${o.label}`}</Text>
              {o.description ? <Text dimColor>{` — ${o.description}`}</Text> : null}
            </Text>
          ))}
          {field.custom ? <Text dimColor>{"  or type a custom answer"}</Text> : null}
        </Box>
      ) : null}

      {isBoolean ? (
        <Box marginTop={1}>
          <Text color="#fabd2f" bold>{"  y / n"}</Text>
        </Box>
      ) : (
        // Free-text and option fields both get an input line. The draft is shown
        // with a trailing inverse-space cursor, using the nested-Text pattern from
        // feedback-ink5-cursor.md (cursor stays inside one Text flow, so it wraps).
        <Box marginTop={1}>
          <Text>
            <Text color="#fabd2f" bold>{"  › "}</Text>
            {draft}
            <Text inverse>{" "}</Text>
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {answerHint}
          {` · Enter to ${submitHint} · `}
          <Text color="#fabd2f" bold>Esc</Text>
          {" to cancel"}
        </Text>
      </Box>
    </Box>
  );
}

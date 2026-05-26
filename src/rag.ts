const RAG_URL = "http://192.168.1.93:8000/v1/rag/search";
const RAG_USER = "florian";
const RAG_TOP_K = 5;
const RAG_SCORE_THRESHOLD = 0.45;

export type RagHit = {
  rank: number;
  score: number;
  file_name: string;
  source_path: string;
  content: string;
  session_title?: string;
};

/**
 * Search the RAG index for documents matching the query.
 * Returns { hits: [...] } on success, { error: "..." } on failure.
 * Single 30-second timeout covers the entire operation.
 */
export async function searchRag(query: string): Promise<{ hits: RagHit[] } | { error: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const params = new URLSearchParams({
      q: query,
      user: RAG_USER,
      top_k: String(RAG_TOP_K),
    });

    const response = await fetch(`${RAG_URL}?${params}`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const hits: RagHit[] = (data.hits || []).map((hit: any, index: number) => ({
      rank: index + 1,
      score: hit.score,
      file_name: hit.file_name,
      source_path: hit.source_path,
      content: hit.content,
      session_title: hit.session_title,
    }));

    return { hits };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      return { error: "timeout (30s)" };
    }
    return { error: String(err) };
  }
}

/**
 * Format a list of RAG hits into a readable block of text.
 * Displays rank, score, file/session name, source path, and first 400 chars of content.
 * Empty hits → "No results found".
 */
export function formatBlockText(hits: RagHit[]): string {
  if (hits.length === 0) {
    return "No results found";
  }

  return hits
    .map((hit) => {
      const label = hit.session_title || hit.file_name;
      const preview = hit.content.slice(0, 400).replace(/\n/g, " ");
      return `${hit.rank}. [${hit.score.toFixed(2)}] ${label}\n   ${hit.source_path}\n   ${preview}`;
    })
    .join("\n\n");
}

/**
 * Format a RAG preamble for injection into the prompt.
 * Filters hits by RAG_SCORE_THRESHOLD and wraps in <RAG context>...</RAG context>.
 * In "only" mode, prepends an instruction to answer ONLY from the context.
 * Returns empty string if no hits pass the threshold.
 */
export function formatPromptPrefix(hits: RagHit[], mode: "on" | "only"): string {
  const filtered = hits.filter((hit) => hit.score >= RAG_SCORE_THRESHOLD);

  if (filtered.length === 0) {
    return "";
  }

  const contextText = filtered
    .map((hit) => {
      const label = hit.session_title || hit.file_name;
      return `[${label}] ${hit.content}`;
    })
    .join("\n\n");

  const instruction =
    mode === "only"
      ? "[Answer ONLY from the RAG context below; otherwise say \"No relevant documents found in the SoHoAI knowledge base.\"]\n\n"
      : "";

  return `${instruction}<RAG context>\n${contextText}\n</RAG context>`;
}

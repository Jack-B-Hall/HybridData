// Central re-export of the committed fixtures, typed against the real API
// contract. Used both by mock-mode (VITE_USE_MOCKS=1) and by e2e route
// interception.
import askSufficientRaw from "./ask_sufficient.json";
import askImpactRaw from "./ask_impact.json";
import askInsufficientRaw from "./ask_insufficient.json";
import askRefusalRaw from "./ask_refusal.json";
import documentsRaw from "./documents.json";
import documentDetailRaw from "./document_detail.json";
import graphOverviewRaw from "./graph_overview.json";
import graphNodeRaw from "./graph_node.json";
import corpusStatsRaw from "./corpus_stats.json";
import ingestHistoryRaw from "./ingest_history.json";
import healthRaw from "./health.json";

import type {
  AskResult,
  CorpusStatsResponse,
  DocumentDetail,
  DocumentListResponse,
  GraphNodeResponse,
  GraphOverviewResponse,
  HealthResponse,
  IngestHistoryResponse,
} from "@/api/types";

export const askSufficient = askSufficientRaw as AskResult;
export const askImpact = askImpactRaw as AskResult;
// NB: despite the filename, this fixture's gate actually returned a
// "sufficient" verdict (a hash-embedder false-positive on an off-corpus
// question) — kept verbatim for API-contract fidelity, not used to drive
// the refusal demo.
export const askInsufficient = askInsufficientRaw as AskResult;
// A genuine refusal captured live from `hde serve` for "What is the capital
// of France?" — this is what actually demonstrates the refusal UI.
export const askRefusal = askRefusalRaw as AskResult;

export const documents = documentsRaw as DocumentListResponse;
export const documentDetail = documentDetailRaw as DocumentDetail;
export const graphOverview = graphOverviewRaw as GraphOverviewResponse;
export const graphNode = graphNodeRaw as GraphNodeResponse;
export const corpusStats = corpusStatsRaw as CorpusStatsResponse;
export const ingestHistory = ingestHistoryRaw as IngestHistoryResponse;
export const health = healthRaw as HealthResponse;

/** Map a free-typed question to the closest fixture, mirroring gate behaviour. */
export function pickAskFixture(question: string): AskResult {
  const q = question.trim().toLowerCase();
  if (q === askSufficient.question.toLowerCase()) return askSufficient;
  if (q === askImpact.question.toLowerCase()) return askImpact;
  if (q === askRefusal.question.toLowerCase()) return askRefusal;
  if (q === askInsufficient.question.toLowerCase()) return askInsufficient;

  if (/lipo|lifepo4|battery chemistry|k-200 battery/.test(q)) return askSufficient;
  if (/ecr-221|propulsion motor/.test(q)) return askImpact;

  // Unknown/off-corpus question typed by the user in mock mode: behave like
  // a refusal, but echo back what was actually typed.
  return { ...askRefusal, question };
}

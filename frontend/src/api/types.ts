// Types modeled exactly on the committed fixtures in src/mocks/fixtures/*.json
// and the contract documented in docs/api.md.

export type ArtifactKind = "entity" | "document" | "person";

export type ProvTierLabel = "formal" | "unverified" | "informal";

export type Verdict = "sufficient" | "borderline" | "insufficient";

export type Confidence = "high" | "medium" | "low";

export type RetrievalLeg = "fts" | "vector" | "graph" | "exact";

export interface HealthResponse {
  status: string;
  llm_backend: string;
  embedder: string;
  db: string;
}

export interface GateSignals {
  id_anchor: boolean;
  term_coverage: number;
  top_score: number;
  n_strong: number;
  n_chunks: number;
  n_terms: number;
  question_ids: string[];
  named_known: string[];
  named_retrieved: string[];
}

export interface Claim {
  text: string;
  citations: string[];
}

export interface Citation {
  marker: number;
  artifact_id: string;
  title: string;
  source: string;
  tier_label: ProvTierLabel;
  chunk_idx: number;
  char_start: number;
  char_end: number;
  passage: string;
  grounded: boolean;
}

export interface Source {
  rowid: number;
  artifact_id: string;
  source: string;
  art_kind: ArtifactKind;
  title: string;
  prov_tier: number;
  tier_label: ProvTierLabel;
  chunk_idx: number;
  char_start: number;
  char_end: number;
  body: string;
  score: number;
  legs: RetrievalLeg[];
}

export interface RetrievalStats {
  exact_hits?: number;
  fts_hits: number;
  vector_hits: number;
  graph_hits: number;
  anchors: string[];
  fused_candidates: number;
}

export interface AskResult {
  question: string;
  answered: boolean;
  verdict: Verdict;
  confidence: Confidence;
  answer: string;
  signals: GateSignals;
  claims: Claim[];
  citations: Citation[];
  graph_paths: string[];
  sources: Source[];
  latency_ms: number;
  backend: string;
  retrieval: RetrievalStats;
  /** Telemetry row id for this ask; feedback (thumbs) attaches to it. 0 = not logged. */
  ask_id: number;
}

export interface AskRequest {
  question: string;
}

// ── Streaming (POST /api/ask/stream, Server-Sent Events) ────────────────────
// The stream emits a single `retrieval` event (sources + graph paths + gate
// verdict, as soon as they are computed), then zero or more `token` events
// (answer prose deltas as the model generates), then a final `done` event whose
// `result` matches the blocking /api/ask response exactly.

export interface RetrievalEvent {
  type: "retrieval";
  answered: boolean;
  verdict: Verdict;
  confidence: Confidence;
  signals: GateSignals;
  backend: string;
  sources: Source[];
  graph_paths: string[];
  retrieval: RetrievalStats;
}

export interface TokenEvent {
  type: "token";
  text: string;
}

export interface DoneEvent {
  type: "done";
  result: AskResult;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type StreamEvent = RetrievalEvent | TokenEvent | DoneEvent | ErrorEvent;

export interface AskStreamHandlers {
  onRetrieval?: (event: RetrievalEvent) => void;
  onToken?: (delta: string) => void;
  onDone?: (result: AskResult) => void;
  onError?: (message: string) => void;
}

export interface DocumentSummary {
  id: string;
  kind: ArtifactKind;
  title: string;
  source: string;
  prov_tier: number;
  tier_label: ProvTierLabel;
  subsystem: string | null;
}

export interface DocumentListResponse {
  count: number;
  documents: DocumentSummary[];
}

export interface DocumentListParams {
  kind?: ArtifactKind;
  source?: string;
  subsystem?: string;
  query?: string;
  limit?: number;
}

export interface DocumentSection {
  chunk_idx: number;
  char_start: number;
  char_end: number;
  body: string;
}

export interface ImpactClosure {
  artifact_id: string;
  title: string;
  prov_tier: number;
  downstream_ids: string[];
  upstream_ids: string[];
  summary: string;
}

export interface DocumentDetail {
  id: string;
  kind: ArtifactKind;
  title: string;
  text: string;
  source: string;
  prov_tier: number;
  tier_label: ProvTierLabel;
  subsystem: string | null;
  parent_id: string | null;
  metadata: Record<string, unknown>;
  sections: DocumentSection[];
  refs: string[];
  referenced_by: string[];
  closure: ImpactClosure;
}

export interface GraphNode {
  id: string;
  kind: ArtifactKind;
  label: string;
  subsystem: string | null;
  source: string;
  prov_tier: number;
}

export interface GraphEdge {
  src: string;
  dst: string;
  rel: string;
}

export interface GraphOverviewStats {
  nodes: number;
  edges: number;
  nodes_by_kind: Record<string, number>;
  edges_by_rel: Record<string, number>;
}

export interface GraphOverviewResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphOverviewStats;
}

export interface GraphNodeResponse {
  center: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CorpusStarterQuestion {
  text: string;
  hint: string;
}

export interface CorpusMeta {
  title: string | null;
  placeholder: string;
  starter_questions: CorpusStarterQuestion[];
  /** Header title + browser tab. */
  app_name: string;
  /** Header glyph + favicon: an emoji, an image path/URL, or null (built-in mark). */
  app_icon: string | null;
  id_pattern: string;
  tier_labels: Record<string, string>;
}

export interface CorpusStatsResponse {
  totals: {
    artifacts: number;
    chunks: number;
    refs: number;
  };
  by_kind: Record<string, number>;
  by_source: Record<string, number>;
  by_tier: Record<string, number>;
  by_subsystem: Record<string, number>;
  graph: GraphOverviewStats;
  embedder: string;
  snapshot_at: string;
}

export interface IngestRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  adapter: string;
  source_path: string;
  n_records: number;
  n_chunks: number;
  n_nodes: number;
  n_edges: number;
  status: string;
  note: string | null;
}

export interface IngestHistoryResponse {
  runs: IngestRun[];
}

// ── Feedback + system-health telemetry ──────────────────────────────────────

export type FeedbackRating = "up" | "down";

export interface FeedbackRequest {
  ask_id: number;
  rating: FeedbackRating;
  comment?: string;
}

export interface FeedbackResponse {
  ok: boolean;
  feedback_id: number;
}

export interface TelemetryRecentAsk {
  id: number;
  ts: string;
  question: string;
  verdict: Verdict | null;
  confidence: Confidence | null;
  answered: boolean;
  latency_ms: number | null;
  status: "ok" | "error" | "abandoned";
  streamed: boolean;
  feedback: FeedbackRating | null;
}

export interface TelemetryHealth {
  totals: {
    asks: number;
    answered: number;
    refused: number;
    errors: number;
    abandoned: number;
  };
  answer_rate: number;
  latency: { p50_ms: number; p95_ms: number };
  feedback: { up: number; down: number; ratio: number };
  per_day: { day: string; count: number }[];
  recent: TelemetryRecentAsk[];
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "@/api";
import type { ArtifactKind, CorpusStatsResponse, DocumentDetail, DocumentSummary } from "@/api/types";
import { DocumentListPane } from "@/components/documents/DocumentListPane";
import { DocumentViewerPane } from "@/components/documents/DocumentViewerPane";

export function DocumentsPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ArtifactKind | "">("");
  const [source, setSource] = useState("");
  const [subsystem, setSubsystem] = useState("");

  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [count, setCount] = useState(0);
  const [listLoading, setListLoading] = useState(true);

  const [stats, setStats] = useState<CorpusStatsResponse | null>(null);

  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    api.getCorpusStats().then(setStats).catch(() => setStats(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    const handle = setTimeout(() => {
      api
        .getDocuments({
          kind: kind || undefined,
          source: source || undefined,
          subsystem: subsystem || undefined,
          query: query || undefined,
          limit: 500,
        })
        .then((res) => {
          if (cancelled) return;
          setDocuments(res.documents);
          setCount(res.count);
        })
        .catch(() => {
          if (!cancelled) {
            setDocuments([]);
            setCount(0);
          }
        })
        .finally(() => {
          if (!cancelled) setListLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [kind, source, subsystem, query]);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    api
      .getDocument(id)
      .then((doc) => {
        if (!cancelled) setDetail(doc);
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : "Document not found");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const sources = useMemo(() => (stats ? Object.keys(stats.by_source).sort() : []), [stats]);
  const subsystems = useMemo(() => (stats ? Object.keys(stats.by_subsystem).sort() : []), [stats]);

  const highlight = useMemo(() => {
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    if (start === null || end === null) return undefined;
    return { start: Number(start), end: Number(end) };
  }, [searchParams]);

  return (
    <div className="grid min-h-[calc(100vh-8.5rem)] grid-cols-1 gap-5 lg:grid-cols-[320px,minmax(0,1fr)]">
      <div className="min-h-0 lg:h-[calc(100vh-8.5rem)]">
        <DocumentListPane
          documents={documents}
          count={count}
          loading={listLoading}
          selectedId={id}
          query={query}
          onQueryChange={setQuery}
          kind={kind}
          onKindChange={setKind}
          source={source}
          onSourceChange={setSource}
          subsystem={subsystem}
          onSubsystemChange={setSubsystem}
          sources={sources}
          subsystems={subsystems}
        />
      </div>

      <div className="min-w-0">
        {!id && <ViewerEmptyState />}
        {id && detailLoading && <ViewerSkeleton />}
        {id && !detailLoading && detailError && (
          <div className="rounded-card border border-confidence-low/30 bg-canvas-raised p-6 text-sm text-confidence-low">
            {detailError}. It may not exist in this corpus.
            <button
              type="button"
              onClick={() => navigate("/documents")}
              className="ml-2 font-semibold underline underline-offset-2"
            >
              Back to list
            </button>
          </div>
        )}
        {id && !detailLoading && !detailError && detail && (
          <DocumentViewerPane document={detail} highlight={highlight} />
        )}
      </div>
    </div>
  );
}

function ViewerEmptyState() {
  return (
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center rounded-card border border-dashed border-border-strong bg-canvas-sunken/60 p-10 text-center">
      <div aria-hidden className="mb-3 text-2xl">
        📄
      </div>
      <p className="text-sm text-ink-muted">Select a document from the list to view its full record.</p>
    </div>
  );
}

function ViewerSkeleton() {
  return (
    <div className="animate-fade-in space-y-4 rounded-card border border-border bg-canvas-raised p-5 shadow-panel">
      <div className="h-4 w-24 animate-pulse rounded bg-canvas-sunken" />
      <div className="h-7 w-2/3 animate-pulse rounded bg-canvas-sunken" />
      <div className="h-4 w-full animate-pulse rounded bg-canvas-sunken" />
      <div className="h-4 w-full animate-pulse rounded bg-canvas-sunken" />
      <div className="h-4 w-5/6 animate-pulse rounded bg-canvas-sunken" />
    </div>
  );
}

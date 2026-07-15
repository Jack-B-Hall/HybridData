import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api";
import type {
  GoldenBehaviour,
  GoldenQuestion,
  GoldenQuestionInput,
  TestResult,
  TestRunDetail,
  TestRunStatus,
  TestRunSummary,
} from "@/api/types";
import { formatDate, formatLatency, formatPercent } from "@/lib/format";

const BEHAVIOURS: GoldenBehaviour[] = ["answer", "refuse"];

export function TestingPage() {
  const [questions, setQuestions] = useState<GoldenQuestion[]>([]);
  const [status, setStatus] = useState<TestRunStatus | null>(null);
  const [runs, setRuns] = useState<TestRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<{ category: string; behaviour: string; enabled: string }>({
    category: "",
    behaviour: "",
    enabled: "",
  });
  const [adding, setAdding] = useState(false);

  const loadQuestions = useCallback(() => {
    api.getGoldenQuestions().then((r) => setQuestions(r.questions)).catch(() => {});
  }, []);
  const loadRuns = useCallback(() => {
    api.getTestRuns().then((r) => setRuns(r.runs)).catch(() => {});
  }, []);

  useEffect(() => {
    loadQuestions();
    loadRuns();
    api.getTestRunStatus().then(setStatus).catch(() => {});
  }, [loadQuestions, loadRuns]);

  const running = status?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      api
        .getTestRunStatus()
        .then((s) => {
          setStatus(s);
          if (!s.running) loadRuns();
        })
        .catch(() => {});
    }, 600);
    return () => clearInterval(timer);
  }, [running, loadRuns]);

  const categories = useMemo(
    () => [...new Set(questions.map((q) => q.category))].sort(),
    [questions],
  );

  const shown = useMemo(
    () =>
      questions.filter(
        (q) =>
          (!filters.category || q.category === filters.category) &&
          (!filters.behaviour || q.behaviour === filters.behaviour) &&
          (!filters.enabled || String(q.enabled) === filters.enabled),
      ),
    [questions, filters],
  );

  async function runTests(runCategories?: string[]) {
    setError(null);
    try {
      setStatus(await api.startTestRun(runCategories ? { categories: runCategories } : {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the test run.");
    }
  }

  async function saveNew(input: GoldenQuestionInput) {
    await api.addGoldenQuestion(input);
    setAdding(false);
    loadQuestions();
  }
  async function saveEdit(id: number, input: GoldenQuestionInput) {
    await api.updateGoldenQuestion(id, input);
    loadQuestions();
  }
  async function toggleEnabled(q: GoldenQuestion) {
    await api.updateGoldenQuestion(q.id, { enabled: !q.enabled });
    loadQuestions();
  }
  async function remove(q: GoldenQuestion) {
    await api.deleteGoldenQuestion(q.id);
    loadQuestions();
  }

  return (
    <div className="space-y-6" data-testid="testing-view">
      <div>
        <h1 className="font-display text-2xl font-medium tracking-tight text-ink">Testing</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Curate a golden set of questions and run them through the live app to confirm its health.
          Grading is deterministic, answered vs refused plus expected citations and keywords. Runs
          happen in the background, you can kick one off and leave.
        </p>
      </div>

      <HealthStrip runs={runs} />

      <RunPanel
        running={running}
        status={status}
        categories={categories}
        error={error}
        onRunAll={() => runTests()}
        onRunCategories={(c) => runTests(c)}
      />

      <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Golden set ({shown.length})
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Filters
              categories={categories}
              filters={filters}
              onChange={(f) => setFilters(f)}
            />
            <button
              type="button"
              data-testid="golden-add"
              onClick={() => setAdding((v) => !v)}
              className="rounded-md border border-accent/40 bg-accent-soft/40 px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:border-accent/70"
            >
              {adding ? "Cancel" : "Add question"}
            </button>
          </div>
        </div>

        {adding && (
          <div className="mb-3">
            <QuestionEditor
              onCancel={() => setAdding(false)}
              onSave={saveNew}
              submitLabel="Add to golden set"
            />
          </div>
        )}

        <GoldenTable
          questions={shown}
          onToggle={toggleEnabled}
          onDelete={remove}
          onSave={saveEdit}
        />
      </div>

      <RunHistory runs={runs} />
    </div>
  );
}

// ── Health strip ─────────────────────────────────────────────────────────────
function HealthStrip({ runs }: { runs: TestRunSummary[] }) {
  const latest = runs[0];
  const prev = runs[1];
  const pass = (r?: TestRunSummary) =>
    r && r.total ? (r.passed ?? 0) / r.total : null;
  const latestPass = pass(latest);
  const prevPass = pass(prev);
  const delta = latestPass != null && prevPass != null ? latestPass - prevPass : null;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="health-strip">
      <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel">
        <div className="text-[11px] uppercase tracking-wide text-ink-faint">Latest pass rate</div>
        <div className="mt-1 font-display text-[28px] font-medium leading-none text-ink" data-testid="health-pass-rate">
          {latestPass == null ? "—" : formatPercent(latestPass)}
        </div>
        {latest && (
          <div className="mt-1 text-[12px] text-ink-faint">
            {latest.passed}/{latest.total} passed
          </div>
        )}
      </div>
      <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel">
        <div className="text-[11px] uppercase tracking-wide text-ink-faint">Trend vs previous</div>
        <div className={`mt-1 font-display text-[28px] font-medium leading-none ${
          delta == null ? "text-ink" : delta >= 0 ? "text-tier-formal" : "text-confidence-low"
        }`}>
          {delta == null ? "—" : `${delta >= 0 ? "+" : ""}${formatPercent(delta)}`}
        </div>
        <div className="mt-1 text-[12px] text-ink-faint">
          {prevPass == null ? "no earlier run" : `was ${formatPercent(prevPass)}`}
        </div>
      </div>
      <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel">
        <div className="text-[11px] uppercase tracking-wide text-ink-faint">Last run</div>
        <div className="mt-1 font-display text-[18px] font-medium leading-tight text-ink">
          {latest ? formatDate(latest.finished_at ?? latest.started_at) : "—"}
        </div>
        {latest && (
          <div className="mt-1 text-[12px] text-ink-faint">
            {latest.backend ?? "—"} · {latest.total} questions
          </div>
        )}
      </div>
    </div>
  );
}

// ── Run panel ────────────────────────────────────────────────────────────────
function RunPanel({
  running,
  status,
  categories,
  error,
  onRunAll,
  onRunCategories,
}: {
  running: boolean;
  status: TestRunStatus | null;
  categories: string[];
  error: string | null;
  onRunAll: () => void;
  onRunCategories: (categories: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (c: string) =>
    setSelected((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));

  return (
    <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">Run tests</h2>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="run-tests"
          disabled={running}
          onClick={onRunAll}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-canvas-raised transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Run all enabled
        </button>
        <button
          type="button"
          data-testid="run-tests-subset"
          disabled={running || selected.length === 0}
          onClick={() => onRunCategories(selected)}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          Run selected {selected.length ? `(${selected.length})` : ""}
        </button>
        <span className="text-[12px] text-ink-faint">Runs in the background, safe to navigate away.</span>
      </div>

      {categories.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5" data-testid="run-category-chips">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggle(c)}
              disabled={running}
              className={`rounded-full border px-2.5 py-1 text-[12px] font-medium capitalize transition-colors disabled:opacity-50 ${
                selected.includes(c)
                  ? "border-accent/60 bg-accent-soft/50 text-accent"
                  : "border-border text-ink-muted hover:border-border-strong hover:text-ink"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-confidence-low" data-testid="test-error">{error}</p>}
      {status && (running || status.status) && (
        <RunProgress status={status} running={running} />
      )}
    </div>
  );
}

function RunProgress({ status, running }: { status: TestRunStatus; running: boolean }) {
  const done = status.done ?? 0;
  const total = status.total ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const errored = status.status === "error";
  return (
    <div
      className={`mt-4 rounded-card border px-3 py-2.5 ${
        errored ? "border-confidence-low/30 bg-confidence-low/5" : "border-accent/30 bg-accent-soft/40"
      }`}
      data-testid="test-progress"
    >
      <div className="flex items-center gap-3">
        {running ? <Spinner /> : null}
        <div className="text-sm text-ink">
          {errored ? (
            <span className="text-confidence-low">{status.error ?? "Run failed."}</span>
          ) : (
            <>
              <span className="font-semibold">{running ? status.stage : "Run complete"}</span>{" "}
              <span className="text-ink-muted">
                — {status.passed} passed, {status.failed} failed{total ? ` of ${total}` : ""}
              </span>
            </>
          )}
        </div>
      </div>
      {running && total > 0 && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-canvas-sunken">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────
function Filters({
  categories,
  filters,
  onChange,
}: {
  categories: string[];
  filters: { category: string; behaviour: string; enabled: string };
  onChange: (f: { category: string; behaviour: string; enabled: string }) => void;
}) {
  const cls =
    "rounded-md border border-border bg-canvas px-2 py-1 text-[12px] text-ink focus:border-accent/60 focus:outline-none";
  return (
    <div className="flex items-center gap-1.5" data-testid="golden-filters">
      <select
        aria-label="Filter by category"
        className={cls}
        value={filters.category}
        onChange={(e) => onChange({ ...filters, category: e.target.value })}
      >
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <select
        aria-label="Filter by behaviour"
        className={cls}
        value={filters.behaviour}
        onChange={(e) => onChange({ ...filters, behaviour: e.target.value })}
      >
        <option value="">Any behaviour</option>
        {BEHAVIOURS.map((b) => (
          <option key={b} value={b}>{b}</option>
        ))}
      </select>
      <select
        aria-label="Filter by enabled"
        className={cls}
        value={filters.enabled}
        onChange={(e) => onChange({ ...filters, enabled: e.target.value })}
      >
        <option value="">Enabled + disabled</option>
        <option value="true">Enabled only</option>
        <option value="false">Disabled only</option>
      </select>
    </div>
  );
}

// ── Golden table ─────────────────────────────────────────────────────────────
function GoldenTable({
  questions,
  onToggle,
  onDelete,
  onSave,
}: {
  questions: GoldenQuestion[];
  onToggle: (q: GoldenQuestion) => void;
  onDelete: (q: GoldenQuestion) => void;
  onSave: (id: number, input: GoldenQuestionInput) => Promise<void>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  if (questions.length === 0) {
    return <p className="text-sm text-ink-faint">No questions match the current filters.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-sm" data-testid="golden-table">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
            <th className="py-1.5 pr-3 font-semibold">Question</th>
            <th className="py-1.5 pr-3 font-semibold">Category</th>
            <th className="py-1.5 pr-3 font-semibold">Expected</th>
            <th className="py-1.5 pr-3 font-semibold">Checks</th>
            <th className="py-1.5 pr-3 font-semibold">Enabled</th>
            <th className="py-1.5 pr-3 font-semibold text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {questions.map((q) => (
            <Fragment key={q.id}>
              <tr className="border-b border-border/60 align-top" data-testid="golden-row">
                <td className="py-2 pr-3 text-ink">{q.text}</td>
                <td className="py-2 pr-3 capitalize text-ink-muted">{q.category}</td>
                <td className="py-2 pr-3">
                  <BehaviourBadge behaviour={q.behaviour} />
                </td>
                <td className="py-2 pr-3 text-[12px] text-ink-muted">
                  {q.citations.length > 0 && <div>cites: {q.citations.join(", ")}</div>}
                  {q.keywords.length > 0 && <div>kw: {q.keywords.join(", ")}</div>}
                  {q.citations.length === 0 && q.keywords.length === 0 && <span>—</span>}
                </td>
                <td className="py-2 pr-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={q.enabled}
                    aria-label={`${q.enabled ? "Disable" : "Enable"} question`}
                    data-testid="golden-toggle"
                    onClick={() => onToggle(q)}
                    className={`inline-flex h-5 w-9 items-center rounded-full border transition-colors ${
                      q.enabled ? "border-accent bg-accent" : "border-border bg-canvas-sunken"
                    }`}
                  >
                    <span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${q.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
                  </button>
                </td>
                <td className="py-2 pr-3 text-right">
                  <button
                    type="button"
                    data-testid="golden-edit"
                    onClick={() => setEditing(editing === q.id ? null : q.id)}
                    className="rounded px-2 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
                  >
                    {editing === q.id ? "Close" : "Edit"}
                  </button>
                  <button
                    type="button"
                    data-testid="golden-delete"
                    onClick={() => onDelete(q)}
                    className="rounded px-2 py-1 text-[12px] font-medium text-confidence-low hover:opacity-80"
                  >
                    Delete
                  </button>
                </td>
              </tr>
              {editing === q.id && (
                <tr className="border-b border-border/60">
                  <td colSpan={6} className="py-2">
                    <QuestionEditor
                      initial={q}
                      submitLabel="Save changes"
                      onCancel={() => setEditing(null)}
                      onSave={async (input) => {
                        await onSave(q.id, input);
                        setEditing(null);
                      }}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BehaviourBadge({ behaviour }: { behaviour: GoldenBehaviour }) {
  return behaviour === "answer" ? (
    <span className="rounded-full border border-tier-formal/30 bg-tier-formal-soft px-2 py-0.5 text-[11px] font-medium text-tier-formal">
      answer
    </span>
  ) : (
    <span className="rounded-full border border-tier-unverified/30 bg-tier-unverified-soft px-2 py-0.5 text-[11px] font-medium text-tier-unverified">
      refuse
    </span>
  );
}

// ── Question editor (add + edit) ─────────────────────────────────────────────
function QuestionEditor({
  initial,
  submitLabel,
  onCancel,
  onSave,
}: {
  initial?: GoldenQuestion;
  submitLabel: string;
  onCancel: () => void;
  onSave: (input: GoldenQuestionInput) => Promise<void>;
}) {
  const [text, setText] = useState(initial?.text ?? "");
  const [category, setCategory] = useState(initial?.category ?? "general");
  const [behaviour, setBehaviour] = useState<GoldenBehaviour>(initial?.behaviour ?? "answer");
  const [citations, setCitations] = useState((initial?.citations ?? []).join(", "));
  const [keywords, setKeywords] = useState((initial?.keywords ?? []).join(", "));
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [busy, setBusy] = useState(false);

  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const field = "w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-ink focus:border-accent/60 focus:outline-none";

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSave({
        text: text.trim(),
        category: category.trim() || "general",
        behaviour,
        citations: split(citations),
        keywords: split(keywords),
        notes: notes.trim() || null,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-accent/30 bg-accent-soft/20 p-3" data-testid="golden-editor">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Question text"
        rows={2}
        data-testid="editor-text"
        className={field}
      />
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Category (e.g. lookup, impact)"
          data-testid="editor-category"
          className={field}
        />
        <select
          value={behaviour}
          onChange={(e) => setBehaviour(e.target.value as GoldenBehaviour)}
          aria-label="Expected behaviour"
          data-testid="editor-behaviour"
          className={field}
        >
          <option value="answer">Expect an answer</option>
          <option value="refuse">Expect a refusal (out of scope)</option>
        </select>
        <input
          value={citations}
          onChange={(e) => setCitations(e.target.value)}
          placeholder="Expected citation ids (comma-separated)"
          data-testid="editor-citations"
          disabled={behaviour === "refuse"}
          className={`${field} disabled:opacity-50`}
        />
        <input
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="Expected keywords (comma-separated)"
          data-testid="editor-keywords"
          disabled={behaviour === "refuse"}
          className={`${field} disabled:opacity-50`}
        />
      </div>
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        className={`${field} mt-2`}
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim() || busy}
          data-testid="editor-save"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-canvas-raised transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── Run history ──────────────────────────────────────────────────────────────
function RunHistory({ runs }: { runs: TestRunSummary[] }) {
  return (
    <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel" data-testid="test-history">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">Run history</h2>
      {runs.length === 0 ? (
        <p className="text-sm text-ink-faint">No test runs yet.</p>
      ) : (
        <div className="space-y-2">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: TestRunSummary }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<TestRunDetail | null>(null);
  const passRate = run.total ? (run.passed ?? 0) / run.total : null;

  useEffect(() => {
    if (open && !detail) {
      api.getTestRun(run.id).then(setDetail).catch(() => {});
    }
  }, [open, detail, run.id]);

  return (
    <div className="rounded-card border border-border/70" data-testid="test-run-row">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-left"
      >
        <span className="text-ink-faint" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="text-sm text-ink-muted">{formatDate(run.finished_at ?? run.started_at)}</span>
        {run.status === "ok" ? (
          <span className="font-mono text-[13px] text-ink">
            {run.passed}/{run.total} passed
            {passRate != null && <span className="text-ink-muted"> · {formatPercent(passRate)}</span>}
          </span>
        ) : (
          <span
            className="rounded-full border border-confidence-low/30 bg-confidence-low/10 px-2 py-0.5 text-[11px] font-medium text-confidence-low"
            title={run.error ?? ""}
          >
            errored
          </span>
        )}
        <span className="text-[12px] text-ink-faint">{run.scope}</span>
        {run.mean_latency_ms != null && (
          <span className="ml-auto font-mono text-[12px] text-ink-faint">
            mean {formatLatency(run.mean_latency_ms)}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border/60 px-3 py-2" data-testid="test-run-detail">
          {run.status === "error" && run.error && (
            <p className="mb-2 text-sm text-confidence-low">{run.error}</p>
          )}
          <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-muted">
            {run.answer_rate != null && <span>Answer rate: {formatPercent(run.answer_rate)}</span>}
            {run.refusal_rate != null && <span>Refusal correctness: {formatPercent(run.refusal_rate)}</span>}
            <span>Backend: {run.backend ?? "—"}</span>
            {run.duration_ms != null && <span>Duration: {formatLatency(run.duration_ms)}</span>}
          </div>
          {detail && <CategoryBreakdown results={detail.results} />}
          {!detail ? (
            <p className="text-sm text-ink-faint">Loading results…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                    <th className="py-1.5 pr-3 font-semibold">Result</th>
                    <th className="py-1.5 pr-3 font-semibold">Question</th>
                    <th className="py-1.5 pr-3 font-semibold">Expected</th>
                    <th className="py-1.5 pr-3 font-semibold">Why</th>
                    <th className="py-1.5 pr-3 font-semibold">Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.results.map((res) => (
                    <tr key={res.id} className="border-b border-border/60 align-top" data-testid="test-result-row">
                      <td className="py-2 pr-3">
                        {res.passed ? (
                          <span className="rounded-full border border-tier-formal/30 bg-tier-formal-soft px-2 py-0.5 text-[11px] font-medium text-tier-formal">
                            pass
                          </span>
                        ) : (
                          <span className="rounded-full border border-confidence-low/30 bg-confidence-low/10 px-2 py-0.5 text-[11px] font-medium text-confidence-low">
                            fail
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-ink">{res.question}</td>
                      <td className="py-2 pr-3"><BehaviourBadge behaviour={res.behaviour} /></td>
                      <td className="py-2 pr-3 text-[12px] text-ink-muted">
                        {res.failed_checks.length ? res.failed_checks.join("; ") : res.error ? res.error : "—"}
                      </td>
                      <td className="py-2 pr-3 font-mono text-[12px] text-ink-faint">
                        {res.latency_ms == null ? "—" : formatLatency(res.latency_ms)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CategoryBreakdown({ results }: { results: TestResult[] }) {
  const byCat = new Map<string, { passed: number; total: number }>();
  for (const r of results) {
    const c = byCat.get(r.category) ?? { passed: 0, total: 0 };
    c.total += 1;
    if (r.passed) c.passed += 1;
    byCat.set(r.category, c);
  }
  if (byCat.size <= 1) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5" data-testid="category-breakdown">
      {[...byCat.entries()].sort().map(([cat, { passed, total }]) => {
        const all = passed === total;
        return (
          <span
            key={cat}
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${
              all
                ? "border-tier-formal/30 bg-tier-formal-soft text-tier-formal"
                : "border-confidence-low/30 bg-confidence-low/10 text-confidence-low"
            }`}
          >
            {cat} {passed}/{total}
          </span>
        );
      })}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin text-accent" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

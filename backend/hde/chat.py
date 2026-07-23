"""Multi-turn chat support: query condensation and bounded history windows.

The multi-turn pipeline (see ``docs/chat.md``) is, per user turn:

    condense (message + recent history -> one standalone question)
      -> retrieve (fresh, through the fused pipeline, every turn)
      -> gate (deterministic, every turn)
      -> grounded synthesis (bounded history window for continuity only)

This module owns the two pieces that are unique to chat, kept free of any store
or HTTP dependency so they are directly unit-testable:

* **Condensation**: rewriting a follow-up ("what does it depend on?") into a
  self-contained question the retrieval pipeline can act on. A message that is
  clearly standalone is passed through untouched; a failed or slow rewrite falls
  back to the raw message (a worse query is still answered honestly, because the
  gate runs on whatever question retrieval actually used). With the mock LLM
  backend the rewrite is deterministic, so offline demos and tests are stable.
* **History bounding**: selecting the window of prior turns that accompanies
  the synthesis prompt. The window is capped by turn count AND total characters,
  and is context for reference resolution only: the model is instructed to
  ground every claim in the retrieved passages, never in the history.
"""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass

from .llm import LLMClient, SynthesisRequest

#: Words that usually mark an implicit reference to an earlier turn ("what does
#: IT depend on?", "who approved THAT?"). Deliberately not exhaustive: a missed
#: reference word only means the raw message goes to retrieval and the gate
#: judges it as-is, which is the honest failure mode.
REFERENCE_WORDS = frozenset({
    "it", "its", "that", "this", "those", "these", "they", "them", "their",
    "he", "she", "him", "her", "his", "hers", "there", "one", "ones", "same",
    "again", "more", "else", "previous", "earlier", "above", "former", "latter",
})

CONDENSE_SYSTEM_PROMPT = (
    "You rewrite the user's newest chat message into ONE standalone question "
    "that can be understood without the conversation. Resolve pronouns and "
    "implicit references using the history provided. Keep the user's intent "
    "exactly: do not answer the question, do not add facts, do not broaden or "
    "narrow it. Reply with only the rewritten question on a single line."
)

#: Hard ceiling on an accepted rewrite; anything longer is treated as a failed
#: rewrite (the model rambled) and the raw message is used instead.
MAX_REWRITE_CHARS = 400

#: Per-turn answer text is clipped to this many characters inside the history
#: window; full answers live in the conversation record, not the prompt.
TURN_ANSWER_CLIP = 700


@dataclass
class CondensedQuestion:
    """The question a chat turn actually retrieves and gates on."""

    question: str
    #: How it was produced: "raw" (standalone or fallback), "llm", or "mock".
    method: str


@dataclass
class HistoryTurn:
    """One prior turn as seen by condensation and the synthesis history block."""

    message: str
    answer: str
    cited_ids: list[str]
    answered: bool


def needs_rewrite(message: str, id_re: "re.Pattern[str]") -> bool:
    """Heuristic: does this message likely depend on earlier turns?

    A message that names a record id is anchored and needs no rewrite. Any
    reference word marks it as a follow-up. A short elliptical message ("and
    the motors?") is also treated as a follow-up even without a pronoun. The
    heuristic is conservative in the safe direction: an unnecessary rewrite of
    a standalone question costs one model call, while the rewritten question
    still faces the same fresh retrieval and the same deterministic gate.
    """
    if id_re.search(message):
        return False
    words = re.findall(r"[a-z']+", message.lower())
    if any(w in REFERENCE_WORDS for w in words):
        return True
    return len(words) < 4


def bound_history(
    turns: list[HistoryTurn], max_turns: int, char_budget: int
) -> list[HistoryTurn]:
    """The most recent turns, newest-last, capped by count and total characters.

    Answers are clipped per turn first; then turns are kept newest-first while
    the running character total stays inside ``char_budget`` (always keeping at
    least the newest turn so a follow-up has something to resolve against).
    """
    window: list[HistoryTurn] = []
    total = 0
    for turn in reversed(turns[-max_turns:] if max_turns > 0 else []):
        clipped = HistoryTurn(
            message=turn.message,
            answer=turn.answer[:TURN_ANSWER_CLIP],
            cited_ids=list(turn.cited_ids),
            answered=turn.answered,
        )
        size = len(clipped.message) + len(clipped.answer)
        if window and total + size > char_budget:
            break
        window.append(clipped)
        total += size
    window.reverse()
    return window


def render_history_block(window: list[HistoryTurn]) -> str:
    """The history window as prompt text, oldest turn first."""
    lines: list[str] = []
    for i, turn in enumerate(window, start=1):
        lines.append(f"Turn {i} user: {turn.message}")
        if turn.answered:
            lines.append(f"Turn {i} assistant: {turn.answer}")
        else:
            lines.append(f"Turn {i} assistant: (declined: not covered by the corpus)")
    return "\n".join(lines)


def _recent_entity_ids(window: list[HistoryTurn], id_re: "re.Pattern[str]") -> list[str]:
    """Record ids the conversation most recently talked about, newest turn first.

    Prefers the ids the previous answer actually cited; falls back to ids named
    in the raw message or answer text (covers refused turns, which cite nothing).
    """
    for turn in reversed(window):
        ids: list[str] = []
        for aid in turn.cited_ids:
            if aid not in ids:
                ids.append(aid)
        if not ids:
            for aid in id_re.findall(f"{turn.message} {turn.answer}"):
                if aid not in ids:
                    ids.append(aid)
        if ids:
            return ids
    return []


def mock_rewrite(
    message: str, window: list[HistoryTurn], id_re: "re.Pattern[str]"
) -> str:
    """Deterministic offline rewrite used with the mock LLM backend.

    Anchors the follow-up to the records the conversation was just about by
    appending the most recently cited ids. Those ids drive exact-id retrieval
    and the gate's id anchor, so a pronoun follow-up lands on the same entity
    the previous turn answered about, with no model call and no randomness.
    """
    ids = _recent_entity_ids(window, id_re)[:3]
    if not ids:
        return message
    return f"{message} (context: {', '.join(ids)})"


def _llm_rewrite(
    llm: LLMClient, message: str, window: list[HistoryTurn], timeout_s: int
) -> str | None:
    """Ask the configured LLM for the standalone rewrite, time-boxed.

    Runs in a worker thread so a slow or unreachable model host can never hang
    the turn: on timeout the turn proceeds with the raw message while the
    stranded call is abandoned. Returns None on any failure.
    """
    prompt = (
        "Conversation history:\n"
        f"{render_history_block(window)}\n\n"
        f"Newest user message: {message}\n\n"
        "Standalone rewrite:"
    )
    request = SynthesisRequest(
        question=message, system_prompt=CONDENSE_SYSTEM_PROMPT, user_prompt=prompt
    )
    box: dict = {}

    def run() -> None:
        try:
            box["out"] = llm.synthesize(request)
        except Exception as exc:  # noqa: BLE001, any failure means fall back
            box["err"] = exc

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(timeout=timeout_s)
    raw = box.get("out")
    if worker.is_alive() or raw is None:
        return None
    # First non-empty line, unquoted; reject empty or runaway output.
    for line in str(raw).splitlines():
        text = line.strip().strip('"').strip()
        if text:
            return text if len(text) <= MAX_REWRITE_CHARS else None
    return None


def condense(
    llm: LLMClient,
    message: str,
    window: list[HistoryTurn],
    id_re: "re.Pattern[str]",
    timeout_s: int = 20,
) -> CondensedQuestion:
    """Produce the standalone question a chat turn retrieves and gates on.

    Standalone messages (or an empty history) pass through as "raw". The mock
    backend rewrites deterministically; real backends rewrite via the model
    with a hard timeout, falling back to the raw message on any failure.
    """
    msg = " ".join(message.split())
    if not window or not needs_rewrite(msg, id_re):
        return CondensedQuestion(question=msg, method="raw")
    if llm.name.startswith("mock"):
        rewritten = mock_rewrite(msg, window, id_re)
        return CondensedQuestion(question=rewritten, method="mock" if rewritten != msg else "raw")
    rewritten = _llm_rewrite(llm, msg, window, timeout_s)
    if rewritten and rewritten != msg:
        return CondensedQuestion(question=rewritten, method="llm")
    return CondensedQuestion(question=msg, method="raw")

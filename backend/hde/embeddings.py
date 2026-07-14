"""Pluggable text embedders.

The engine only needs one capability from an embedder: turn a batch of strings
into a batch of fixed-width float vectors. That contract is small enough to
swap freely, so we ship three implementations and pick one from configuration:

* :class:`HashEmbedder` — deterministic, dependency-free, and offline. It hashes
  token n-grams into a fixed-width bag-of-features vector. Vector search quality
  is modest (it captures lexical overlap, not semantics), but it makes tests and
  the offline demo completely reproducible with no model download or GPU. BM25
  and the knowledge graph carry retrieval quality in this mode.
* :class:`OllamaEmbedder` — calls a local Ollama server (e.g. nomic-embed-text).
  This is the recommended production embedder: strong semantics, runs on the same
  box as the answer model, and text never leaves the host. It discovers its output
  dimension from the server, so any embed model works without configuring a size.
* :class:`SentenceTransformerEmbedder` — a local sentence-transformers model, for
  deployments that prefer an in-process embedder over a sidecar service.

Select via ``HDE_EMBEDDER`` (``hash`` | ``ollama`` | ``sbert``).
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import urllib.request
from typing import Protocol, Sequence

from .config import Settings

_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9\-]*")


class Embedder(Protocol):
    """The single method the retrieval layer depends on."""

    dim: int

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Return one vector per input string, each of length ``self.dim``."""
        ...


class HashEmbedder:
    """Deterministic hashing embedder. No dependencies, no network, no GPU.

    Each document is tokenised, expanded to unigrams+bigrams, and hashed into a
    fixed number of buckets weighted by a sublinear term frequency. The vector is
    L2-normalised so cosine similarity reduces to a dot product, matching how the
    downstream vector index scores neighbours.
    """

    def __init__(self, dim: int = 1024) -> None:
        self.dim = dim

    def _features(self, text: str) -> list[str]:
        toks = _TOKEN_RE.findall(text.lower())
        grams = list(toks)
        grams += [f"{a}_{b}" for a, b in zip(toks, toks[1:])]
        return grams

    def _bucket(self, feature: str) -> int:
        h = hashlib.blake2b(feature.encode(), digest_size=8).digest()
        return int.from_bytes(h, "big") % self.dim

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for text in texts:
            vec = [0.0] * self.dim
            counts: dict[int, int] = {}
            for feat in self._features(text):
                b = self._bucket(feat)
                counts[b] = counts.get(b, 0) + 1
            for b, c in counts.items():
                vec[b] = 1.0 + math.log(c)  # sublinear tf
            norm = math.sqrt(sum(v * v for v in vec)) or 1.0
            out.append([v / norm for v in vec])
        return out


class OllamaEmbedder:
    """Embeds via a local Ollama server's ``/api/embed`` endpoint."""

    def __init__(self, host: str, model: str, dim: int | None = None) -> None:
        self.host = host.rstrip("/")
        self.model = model
        # Discover the true output dimension from the server (a single probe), so
        # the store is sized correctly for whatever embed model is configured.
        self.dim = dim or len(self.embed(["dimension probe"])[0])

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        payload = json.dumps({"model": self.model, "input": list(texts)}).encode()
        req = urllib.request.Request(
            f"{self.host}/api/embed",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
        return data["embeddings"]


class SentenceTransformerEmbedder:
    """Embeds with an in-process sentence-transformers model (lazy-loaded)."""

    def __init__(self, model_name: str) -> None:
        from sentence_transformers import SentenceTransformer  # local import: optional dep

        self._model = SentenceTransformer(model_name)
        self.dim = self._model.get_sentence_embedding_dimension()

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        vecs = self._model.encode(list(texts), normalize_embeddings=True)
        return [v.tolist() for v in vecs]


def build_embedder(settings: Settings) -> Embedder:
    """Construct the embedder named by ``settings.embedder``."""
    kind = settings.embedder.lower()
    if kind == "hash":
        return HashEmbedder(dim=settings.embed_dim)
    if kind == "ollama":
        # dim=None -> discovered from the server, so any embed model just works.
        return OllamaEmbedder(host=settings.ollama_embed_host, model=settings.embed_model)
    if kind == "sbert":
        return SentenceTransformerEmbedder(settings.sbert_model)
    raise ValueError(f"unknown embedder {settings.embedder!r} (use hash|ollama|sbert)")

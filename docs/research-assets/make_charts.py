#!/usr/bin/env python3
"""Generate the architecture bake-off charts for docs/architecture-research.md.

Run with the repo venv:  .venv/bin/python docs/research-assets/make_charts.py
All figures are written next to this script as light-background PNGs.
"""
from pathlib import Path
import numpy as np
import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap

OUT = Path(__file__).resolve().parent

# ---- shared style -------------------------------------------------------
mpl.rcParams.update({
    "figure.facecolor": "white",
    "axes.facecolor": "white",
    "savefig.facecolor": "white",
    "font.size": 11,
    "font.family": "DejaVu Sans",
    "axes.edgecolor": "#4a4a4a",
    "axes.linewidth": 0.8,
    "axes.grid": True,
    "grid.color": "#e6e6e6",
    "grid.linewidth": 0.8,
    "axes.axisbelow": True,
    "xtick.color": "#333333",
    "ytick.color": "#333333",
    "axes.labelcolor": "#222222",
    "text.color": "#222222",
})

# Architecture order and short labels
ARCHS = ["A", "B", "C", "D", "E", "F", "G", "H"]
ARCH_LABEL = {
    "A": "A\nvector-rag",
    "B": "B\nhybrid-kg",
    "C": "C\nagentic",
    "D": "D\ngraphrag",
    "E": "E\nenhanced",
    "F": "F\nstaged",
    "G": "G\ngated",
    "H": "H\ngated-iso",
}

# Model columns (deployment-relevant local models first, then reference)
MODELS = ["gemma12b", "gemma26b-moe", "gemma31b", "nemotron33b", "haiku-proxy", "opus-ceiling"]
MODEL_LABEL = {
    "gemma12b": "gemma 12B",
    "gemma26b-moe": "gemma 26B-MoE",
    "gemma31b": "gemma 31B",
    "nemotron33b": "nemotron 33B",
    "haiku-proxy": "haiku (ref)",
    "opus-ceiling": "opus (ceiling)",
}
LOCAL = ["gemma12b", "gemma26b-moe", "gemma31b", "nemotron33b"]

# overall % ; None => excluded (generation crash, not a score)
OVERALL = {
    "A": {"gemma12b": 61.7, "gemma26b-moe": 68.3, "gemma31b": 65.0, "nemotron33b": 64.9, "haiku-proxy": 75.0, "opus-ceiling": 65.0},
    "B": {"gemma12b": 57.7, "gemma26b-moe": 65.4, "gemma31b": 66.2, "nemotron33b": 58.6, "haiku-proxy": 67.5, "opus-ceiling": 80.0},
    "C": {"gemma12b": 56.2, "gemma26b-moe": 51.2, "gemma31b": 33.8, "nemotron33b": 52.5, "haiku-proxy": 55.0, "opus-ceiling": 53.8},
    "D": {"gemma12b": 51.2, "gemma26b-moe": 53.8, "gemma31b": 41.2, "nemotron33b": 25.6, "haiku-proxy": 51.4, "opus-ceiling": 31.2},
    "E": {"gemma12b": 58.8, "gemma26b-moe": 53.8, "gemma31b": 30.8, "nemotron33b": 53.8, "haiku-proxy": 60.0, "opus-ceiling": 28.7},
    "F": {"gemma12b": 36.2, "gemma26b-moe": 52.5, "gemma31b": 58.8, "nemotron33b": 50.0, "haiku-proxy": 60.0, "opus-ceiling": None},
    "G": {"gemma12b": 64.7, "gemma26b-moe": 61.5, "gemma31b": 55.0, "nemotron33b": 55.4, "haiku-proxy": 69.2, "opus-ceiling": None},
    "H": {"gemma12b": 63.2, "gemma26b-moe": 64.1, "gemma31b": 65.0, "nemotron33b": 64.3, "haiku-proxy": 63.7, "opus-ceiling": None},
}

# citation recall (local models)
CITREC = {
    "A": {"gemma12b": 0.389, "gemma26b-moe": 0.399, "gemma31b": 0.389, "nemotron33b": 0.368},
    "B": {"gemma12b": 0.553, "gemma26b-moe": 0.626, "gemma31b": 0.537, "nemotron33b": 0.579},
    "C": {"gemma12b": 0.352, "gemma26b-moe": 0.416, "gemma31b": 0.260, "nemotron33b": 0.284},
    "D": {"gemma12b": 0.071, "gemma26b-moe": 0.029, "gemma31b": 0.116, "nemotron33b": 0.005},
    "E": {"gemma12b": 0.357, "gemma26b-moe": 0.346, "gemma31b": 0.216, "nemotron33b": 0.211},
    "F": {"gemma12b": 0.199, "gemma26b-moe": 0.361, "gemma31b": 0.440, "nemotron33b": 0.354},
    "G": {"gemma12b": 0.551, "gemma26b-moe": 0.632, "gemma31b": 0.497, "nemotron33b": 0.598},
    "H": {"gemma12b": 0.528, "gemma26b-moe": 0.659, "gemma31b": 0.573, "nemotron33b": 0.582},
}

# median ms per question, recommended local model (gemma 26B-MoE) where meaningful
LATENCY_S = {  # seconds, gemma 26B-MoE row
    "A": 107.4, "B": 31.8, "C": 320.7, "D": 143.9,
    "E": 209.3, "F": 237.3, "G": 24.7, "H": 26.9,
}

TEAL = "#1f7a8c"
CORAL = "#e07a5f"
NAVY = "#22333b"
SLATE = "#5c6b73"
GOLD = "#e0a458"
GREY = "#c9ced1"


def local_mean(table):
    return np.mean([table[m] for m in LOCAL])


# =========================================================================
# 1. Heatmap: overall % per architecture x model
# =========================================================================
def chart_heatmap():
    grid = np.full((len(ARCHS), len(MODELS)), np.nan)
    for i, a in enumerate(ARCHS):
        for j, m in enumerate(MODELS):
            v = OVERALL[a][m]
            if v is not None:
                grid[i, j] = v

    cmap = LinearSegmentedColormap.from_list(
        "bakeoff", ["#f7e6df", "#f2c9a0", "#9fc8c4", "#3d8b83", "#1f5e57"])
    cmap.set_bad("#e9ecef")

    fig, ax = plt.subplots(figsize=(9.0, 7.4))
    im = ax.imshow(grid, cmap=cmap, vmin=25, vmax=82, aspect="auto")

    ax.set_xticks(range(len(MODELS)))
    ax.set_xticklabels([MODEL_LABEL[m] for m in MODELS], rotation=30, ha="right")
    ax.set_yticks(range(len(ARCHS)))
    ax.set_yticklabels([ARCH_LABEL[a].replace("\n", " ") for a in ARCHS])

    # divider between local models and reference models
    ax.axvline(3.5, color="#22333b", linewidth=1.6, linestyle=(0, (4, 2)))
    ax.text(2.0 / 6, 1.015, "deployment-relevant local models", transform=ax.transAxes,
            ha="center", fontsize=9.0, color="#22333b", fontweight="bold")
    ax.text(5.0 / 6, 1.015, "reference points", transform=ax.transAxes,
            ha="center", fontsize=9.0, color="#5c6b73")

    for i, a in enumerate(ARCHS):
        for j, m in enumerate(MODELS):
            v = OVERALL[a][m]
            if v is None:
                ax.text(j, i, "excl.", ha="center", va="center",
                        fontsize=8.5, color="#8a939b", style="italic")
            else:
                tc = "white" if v >= 60 else "#3a2f2a"
                ax.text(j, i, f"{v:.0f}", ha="center", va="center",
                        fontsize=10, color=tc, fontweight="normal")

    cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
    cb.set_label("overall accuracy (%)", fontsize=10)
    ax.set_title("Overall answer accuracy: 8 architectures × 6 models",
                 fontsize=13, fontweight="bold", pad=42)
    fig.text(0.5, 0.015,
             "Opus-ceiling cells for F/G/H marked “excl.” = generation-time tooling crash, not an architecture score.",
             ha="center", fontsize=8.8, color="#5c6b73")
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(OUT / "fig1-overall-heatmap.png", dpi=150, bbox_inches="tight")
    plt.close(fig)


# =========================================================================
# 2. Citation recall by architecture (local-model mean, sorted)
# =========================================================================
def chart_citation_recall():
    means = {a: local_mean(CITREC[a]) for a in ARCHS}
    order = sorted(ARCHS, key=lambda a: means[a], reverse=True)
    vals = [means[a] for a in order]
    labels = [ARCH_LABEL[a].replace("\n", " ") for a in order]

    colors = []
    for a in order:
        if a in ("B", "H", "G"):
            colors.append(TEAL)
        elif a == "A":
            colors.append(CORAL)
        else:
            colors.append(SLATE)

    fig, ax = plt.subplots(figsize=(9.0, 5.2))
    bars = ax.bar(labels, vals, color=colors, width=0.66, edgecolor="white")
    for b, v in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, v + 0.008, f"{v:.2f}",
                ha="center", va="bottom", fontsize=10, fontweight="normal")

    ax.set_ylabel("citation recall (local-model mean)")
    ax.set_ylim(0, 0.72)
    ax.set_title("Citation recall by architecture",
                 fontsize=13, fontweight="bold", pad=42)
    ax.text(0.5, 1.045,
            "Fraction of the truly-supporting source documents surfaced. The hybrid-KG family (teal) "
            "leads;\nplain vector-RAG (coral) trails; graphrag loses artifact ids in its cluster summaries.",
            transform=ax.transAxes, ha="center", fontsize=9, color="#5c6b73")

    from matplotlib.patches import Patch
    ax.legend(handles=[
        Patch(color=TEAL, label="hybrid-KG family (B / H / G)"),
        Patch(color=CORAL, label="plain vector-RAG (A)"),
        Patch(color=SLATE, label="other architectures"),
    ], loc="upper right", frameon=False, fontsize=9)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    fig.savefig(OUT / "fig2-citation-recall.png", dpi=150, bbox_inches="tight")
    plt.close(fig)


# =========================================================================
# 3. Headroom: local-model mean vs opus ceiling (A flat vs B scaling)
# =========================================================================
def chart_headroom():
    # Only A and B have clean opus-ceiling cells; those are the comparison.
    fig, ax = plt.subplots(figsize=(8.4, 5.6))

    x = [0, 1]
    a_pts = [local_mean({m: OVERALL["A"][m] for m in LOCAL}), OVERALL["A"]["opus-ceiling"]]
    b_pts = [local_mean({m: OVERALL["B"][m] for m in LOCAL}), OVERALL["B"]["opus-ceiling"]]

    ax.plot(x, a_pts, "-o", color=CORAL, linewidth=2.6, markersize=10,
            label="A  vector-rag (plain RAG)")
    ax.plot(x, b_pts, "-o", color=TEAL, linewidth=2.6, markersize=10,
            label="B  hybrid-kg (fused + graph)")

    # A is above B on the left, below B on the right, so offset labels accordingly
    for xi, v, dy in zip(x, a_pts, (14, -20)):
        ax.annotate(f"{v:.1f}", (xi, v), textcoords="offset points",
                    xytext=(0, dy), ha="center", fontsize=10, color=CORAL, fontweight="bold")
    for xi, v, dy in zip(x, b_pts, (-20, 14)):
        ax.annotate(f"{v:.1f}", (xi, v), textcoords="offset points",
                    xytext=(0, dy), ha="center", fontsize=10, color=TEAL, fontweight="bold")

    # headroom bracket on B
    ax.annotate("", xy=(1.06, b_pts[1]), xytext=(1.06, b_pts[0]),
                arrowprops=dict(arrowstyle="<->", color=NAVY, lw=1.4))
    ax.text(1.10, (b_pts[0] + b_pts[1]) / 2, f"+{b_pts[1]-b_pts[0]:.0f} pts\nheadroom",
            va="center", ha="left", fontsize=9.5, color=NAVY, fontweight="bold")
    ax.text(1.10, (a_pts[0] + a_pts[1]) / 2 - 3.5, "~0 pts\n(saturated)",
            va="center", ha="left", fontsize=9.5, color=CORAL)

    ax.set_xticks(x)
    ax.set_xticklabels(["local-model mean\n(4 local models)", "capability ceiling\n(opus, clean cell)"])
    ax.set_ylabel("overall accuracy (%)")
    ax.set_xlim(-0.25, 1.55)
    ax.set_ylim(50, 85)
    ax.set_title("Capability headroom: does a better model help?",
                 fontsize=13, fontweight="bold", pad=46)
    ax.text(0.5, 1.055,
            "Plain RAG scores the same at the frontier as on local models: the architecture, not the "
            "model, is the ceiling.\nThe hybrid architecture converts extra model quality into +18 points.",
            transform=ax.transAxes, ha="center", fontsize=9, color="#5c6b73")
    ax.legend(loc="lower right", frameon=False, fontsize=10)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    fig.savefig(OUT / "fig3-headroom.png", dpi=150, bbox_inches="tight")
    plt.close(fig)


# =========================================================================
# 4. Latency per architecture (recommended 26B-MoE model)
# =========================================================================
def chart_latency():
    order = sorted(ARCHS, key=lambda a: LATENCY_S[a])
    vals = [LATENCY_S[a] for a in order]
    labels = [ARCH_LABEL[a].replace("\n", " ") for a in order]
    colors = [TEAL if a in ("B", "H", "G") else (CORAL if a == "A" else SLATE) for a in order]

    fig, ax = plt.subplots(figsize=(9.0, 5.2))
    bars = ax.barh(labels, vals, color=colors, height=0.66, edgecolor="white")
    ax.invert_yaxis()
    for b, v in zip(bars, vals):
        ax.text(v + 4, b.get_y() + b.get_height() / 2, f"{v:.0f}s",
                va="center", ha="left", fontsize=10, fontweight="normal")

    ax.set_xlabel("median latency per question (seconds), gemma 26B-MoE")
    ax.set_xlim(0, 360)
    ax.set_title("Latency cost by architecture",
                 fontsize=13, fontweight="bold", pad=42)
    ax.text(0.5, 1.05,
            "The single-shot hybrid + gate configurations (B / H / G) are also the fastest; "
            "agentic loops and\nheavy rerank/verify scaffolding (C / E / F) cost 5–10× the wall-clock time.",
            transform=ax.transAxes, ha="center", fontsize=9, color="#5c6b73")
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    fig.savefig(OUT / "fig4-latency.png", dpi=150, bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    chart_heatmap()
    chart_citation_recall()
    chart_headroom()
    chart_latency()
    print("charts written to", OUT)

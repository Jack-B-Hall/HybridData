"""Provenance tiering.

Real document-intelligence systems mix authoritative records with informal
context. A formally released PLM/PLM-equivalent document should outrank an
equally-relevant meeting note, and an answer built on an unverified source
should be caveated as such. We model that as three ordered tiers derived
deterministically from each record's ``source`` label, and apply a *gentle*
multiplicative weight during ranking — a tie-breaker, never a hard filter,
because provenance questions frequently hinge on exactly the low-tier ticket or
meeting note that recorded a decision.

Map your own sources to a tier by editing :data:`SOURCE_TIER`.
"""
from __future__ import annotations

TIER_FORMAL = 1       # released / controlled records (specs, ECNs, drawings)
TIER_UNVERIFIED = 2   # collaborative notes (wiki pages, meeting minutes)
TIER_INFORMAL = 3     # everything else (tickets, source control, chat)

TIER_LABEL = {
    TIER_FORMAL: "formal",
    TIER_UNVERIFIED: "unverified",
    TIER_INFORMAL: "informal",
}

# Ranking weights. Kept close to 1.0 so tier only breaks near-ties.
TIER_WEIGHT = {
    TIER_FORMAL: 1.00,
    TIER_UNVERIFIED: 0.92,
    TIER_INFORMAL: 0.88,
}

# Which source labels map to which tier. Unknown sources fall back to informal.
SOURCE_TIER = {
    "PLM": TIER_FORMAL,
    "Confluence": TIER_UNVERIFIED,
    "Jira": TIER_INFORMAL,
    "SCM": TIER_INFORMAL,
    "markdown": TIER_UNVERIFIED,
    "csv": TIER_INFORMAL,
}


def tier_for(source: str) -> int:
    """Map a record's ``source`` label to its provenance tier."""
    return SOURCE_TIER.get(source, TIER_INFORMAL)


def label_for(tier: int) -> str:
    return TIER_LABEL.get(tier, "informal")


def weight_for(tier: int) -> float:
    return TIER_WEIGHT.get(tier, TIER_WEIGHT[TIER_INFORMAL])

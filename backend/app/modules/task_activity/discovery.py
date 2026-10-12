"""Replaceable extraction boundary. A proposal is data, never execution authority.

The shipping provider only recognizes explicit task markers in already-grounded
OCR excerpts. It is not a natural-language model and does not establish MineContext
SmartTodo parity. Future providers must still pass exact evidence validation.
"""
import re
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Proposal:
    title: str
    quote: str
    self_assigned: bool
    unfinished: bool
    confidence: float


class DiscoveryResultError(ValueError):
    """A fixed, content-free rejection of model proposal data."""


class DiscoveryProvider(Protocol):
    name: str
    def extract(self, excerpts: tuple[str, ...]) -> list[Proposal]: ...


class EvidenceRules:
    name = 'evidence_rules_v1'
    # Deliberately avoid date/status inference and substring/semantic task merges.
    explicit = re.compile(r'^(?:TODO\s*\(\s*me\s*\)|我的待办)\s*[:：]\s*(\S.{0,179})$', re.I)
    candidate = re.compile(r'^(?:TODO|待办|可能需要)\s*[:：]\s*(\S.{0,179})$|^\s*-\s*\[ \]\s*(\S.{0,179})$', re.I)

    def extract(self, excerpts):
        result = []
        for quote in excerpts:
            for line in quote.splitlines():
                line = line.strip()
                explicit = self.explicit.fullmatch(line)
                possible = self.candidate.fullmatch(line)
                if explicit:
                    result.append(Proposal(explicit.group(1).strip(), line, True, True, .95))
                elif possible:
                    title = next(value for value in possible.groups() if value)
                    result.append(Proposal(title.strip(), line, False, True, .6))
        return result[:8]


def proposal_validation_error(proposal, excerpts):
    # Keep shape/bounds failures distinct from exact-source ancestry. Neither
    # category contains the rejected value or permits a repaired/partial batch.
    if not (isinstance(proposal, Proposal) and isinstance(proposal.title, str)
        and 0 < len(proposal.title.strip()) <= 200 and isinstance(proposal.quote, str)
        and 0 < len(proposal.quote) <= 200
        and type(proposal.self_assigned) is bool and type(proposal.unfinished) is bool
        and type(proposal.confidence) in (int, float) and 0 <= proposal.confidence <= 1):
        return 'invalid_discovery_result'
    if (proposal.title not in proposal.quote
            or not any(proposal.quote in quote for quote in excerpts)):
        return 'discovery_source_mismatch'
    return None


def valid_proposal(proposal, excerpts):
    return proposal_validation_error(proposal, excerpts) is None

"""CLI smoke test for Rakshak AI.

Runs without API keys (import + overlay checks). If SARVAM_API_KEY is set,
processes the first mock transcript end-to-end.
"""

from __future__ import annotations

import json
import os
import sys

from dotenv import load_dotenv

from mock_calls import MOCK_EMERGENCY_CALLS
from pipeline import apply_priority_overlay, flatten_extraction


def test_overlay():
    extraction = {
        "weapon_mentioned": {"is_weapon_present": True, "weapon_type": "knife"},
        "immediate_danger": {"is_immediate_danger": True, "risk_level": 9},
        "incident_type": {"primary": "Domestic Violence"},
        "distress_indicators": {"caller_state": "distressed"},
        "location": {"area": "Manish Nagar"},
        "summary": "Caller reports armed domestic assault.",
    }
    llm_priority = {
        "priority_level": "MEDIUM",
        "confidence": 0.4,
        "explanation": "LLM tried to downgrade",
        "decision_factors": ["tone only"],
    }
    result = apply_priority_overlay(extraction, llm_priority)
    assert result["level"] == "HIGH", result
    assert result["rule_floor"] == "HIGH", result
    flat = flatten_extraction(extraction)
    assert flat["weapon_mentioned"] is True
    assert flat["location"] == "Manish Nagar"
    print("overlay: HIGH floor held against LLM downgrade")


def test_live_pipeline():
    load_dotenv()
    if not os.getenv("SARVAM_API_KEY"):
        print("live API: skipped (SARVAM_API_KEY not set)")
        return
    from pipeline import RakshakPipeline

    call = MOCK_EMERGENCY_CALLS[0]
    print(f"live API: processing {call['call_id']} ({call['scenario']})")
    pipeline = RakshakPipeline()
    result = pipeline.process_text(call["transcript"], source_hint=call["original_language"])
    print(json.dumps(
        {
            "language": result["original_language"],
            "location": result["extraction"]["location"],
            "incident": result["extraction"]["incident_type"],
            "weapon": result["extraction"]["weapon_mentioned"],
            "danger": result["extraction"]["immediate_danger"],
            "priority": result["priority"]["level"],
            "llm_used": result["llm_used"],
            "total_ms": result["timings"]["total_ms"],
        },
        ensure_ascii=False,
        indent=2,
    ))


def main():
    print("Rakshak AI smoke test")
    print("=" * 40)
    print(f"mock calls loaded: {len(MOCK_EMERGENCY_CALLS)}")
    test_overlay()
    test_live_pipeline()
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Memory storage for Rakshak AI incident records and analytics."""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).parent / "data"
RECORDS_FILE = DATA_DIR / "records.json"
_LOCK = threading.Lock()


def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not RECORDS_FILE.exists():
        with open(RECORDS_FILE, "w", encoding="utf-8") as f:
            json.dump([], f, indent=2, ensure_ascii=False)


def _load_raw_records() -> list[dict[str, Any]]:
    _ensure_data_dir()
    try:
        with open(RECORDS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_raw_records(records: list[dict[str, Any]]):
    _ensure_data_dir()
    temp_file = RECORDS_FILE.with_suffix(".tmp")
    with open(temp_file, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)
    temp_file.replace(RECORDS_FILE)


class MemoryStore:
    """Thread-safe persistent memory store for emergency response records."""

    @staticmethod
    def save_record(record_data: dict[str, Any]) -> dict[str, Any]:
        """Save a new record or update an existing one."""
        with _LOCK:
            records = _load_raw_records()

            record_id = record_data.get("id") or record_data.get("call_id")
            if not record_id or record_id.startswith("CALL_"):
                now_str = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
                record_id = f"REC-{now_str}-{len(records) + 1:03d}"

            now_iso = datetime.now(timezone.utc).isoformat()
            now_time = datetime.now(timezone.utc).astimezone().strftime("%d %b %Y, %H:%M:%S")

            entry = {
                "id": record_id,
                "call_id": record_data.get("call_id") or record_id,
                "scenario": record_data.get("scenario") or "Emergency Call",
                "source": record_data.get("source") or "text",
                "created_at": record_data.get("created_at") or now_iso,
                "timestamp_formatted": record_data.get("timestamp_formatted") or now_time,
                "original_language": record_data.get("original_language") or "Unknown",
                "language_code": record_data.get("language_code"),
                "language_confidence": float(record_data.get("language_confidence") or 0.0),
                "transcript_original": record_data.get("transcript_original") or "",
                "transcript_english": record_data.get("transcript_english") or "",
                "transcript_marathi": record_data.get("transcript_marathi") or "",
                "speaker_gender": record_data.get("speaker_gender") or "Male",
                "speaker_used": record_data.get("speaker_used") or "shubh",
                "original_audio_base64": record_data.get("original_audio_base64") or "",
                "translated_audio_base64": record_data.get("translated_audio_base64") or "",
                "extraction": record_data.get("extraction") or {},
                "priority": record_data.get("priority") or {},
                "timings": record_data.get("timings") or {},
                "llm_used": record_data.get("llm_used") or "rules",
                "dispatched": bool(record_data.get("dispatched", False)),
                "dispatch_info": record_data.get("dispatch_info") or None,
            }

            # If already exists with this ID, replace it
            existing_idx = next((i for i, r in enumerate(records) if r.get("id") == record_id), -1)

            # If no ID match, check if the most recent record has the exact same transcript (prevent accidental duplicate submit)
            if existing_idx < 0 and records and entry.get("transcript_original"):
                latest = records[0]
                if (latest.get("transcript_original") or "").strip() == entry.get("transcript_original", "").strip():
                    existing_idx = 0
                    entry["id"] = latest["id"]
                    entry["call_id"] = latest["call_id"]
                    entry["created_at"] = latest["created_at"]
                    entry["timestamp_formatted"] = latest["timestamp_formatted"]

            if existing_idx >= 0:
                records[existing_idx] = entry
            else:
                records.insert(0, entry)

            _save_raw_records(records)
            return entry

    @staticmethod
    def get_records(
        query: str | None = None,
        priority: str | None = None,
        language: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Retrieve stored records with optional filtering."""
        with _LOCK:
            records = _load_raw_records()

        filtered = records
        if query:
            q = query.lower().strip()
            filtered = [
                r for r in filtered
                if q in str(r.get("id", "")).lower()
                or q in str(r.get("scenario", "")).lower()
                or q in str(r.get("transcript_original", "")).lower()
                or q in str(r.get("transcript_english", "")).lower()
                or q in str((r.get("extraction") or {}).get("location", "")).lower()
                or q in str((r.get("extraction") or {}).get("incident_type", "")).lower()
            ]

        if priority and priority.upper() != "ALL":
            p = priority.upper()
            filtered = [
                r for r in filtered
                if ((r.get("priority") or {}).get("level") or "").upper() == p
            ]

        if language and language.upper() != "ALL":
            lang = language.lower()
            filtered = [
                r for r in filtered
                if lang in str(r.get("original_language", "")).lower()
            ]

        return filtered[offset : offset + limit]

    @staticmethod
    def get_record(record_id: str) -> dict[str, Any] | None:
        """Get a specific record by ID."""
        with _LOCK:
            records = _load_raw_records()
            return next((r for r in records if r.get("id") == record_id or r.get("call_id") == record_id), None)

    @staticmethod
    def update_record_dispatch(record_id: str, dispatch_entry: dict[str, Any]) -> bool:
        """Update dispatch status of a record."""
        with _LOCK:
            records = _load_raw_records()
            for r in records:
                if r.get("id") == record_id or r.get("call_id") == record_id:
                    r["dispatched"] = True
                    r["dispatch_info"] = dispatch_entry
                    _save_raw_records(records)
                    return True
        return False

    @staticmethod
    def delete_record(record_id: str) -> bool:
        """Delete a record by ID."""
        with _LOCK:
            records = _load_raw_records()
            initial_len = len(records)
            records = [r for r in records if r.get("id") != record_id and r.get("call_id") != record_id]
            if len(records) != initial_len:
                _save_raw_records(records)
                return True
        return False

    @staticmethod
    def clear_all() -> int:
        """Clear all records from memory."""
        with _LOCK:
            records = _load_raw_records()
            count = len(records)
            _save_raw_records([])
            return count

    @staticmethod
    def get_analytics() -> dict[str, Any]:
        """Compute aggregated statistics across all saved incident records."""
        with _LOCK:
            records = _load_raw_records()

        total_records = len(records)
        if total_records == 0:
            return {
                "total_records": 0,
                "priority_breakdown": {"HIGH": 0, "MEDIUM": 0, "LOW": 0},
                "language_distribution": {},
                "incident_types": {},
                "location_distribution": {},
                "weapon_stats": {"present": 0, "not_present": 0, "types": {}},
                "immediate_danger_count": 0,
                "dispatched_count": 0,
                "average_latencies": {"speech_ms": 0, "translate_ms": 0, "extract_ms": 0, "tts_ms": 0, "total_ms": 0},
                "caller_states": {},
            }

        priority_counts = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
        lang_counts: dict[str, int] = {}
        incident_counts: dict[str, int] = {}
        location_counts: dict[str, int] = {}
        caller_states: dict[str, int] = {}
        weapon_present_count = 0
        weapon_types: dict[str, int] = {}
        immediate_danger_count = 0
        dispatched_count = 0

        total_speech_ms = 0
        speech_count = 0
        total_translate_ms = 0
        translate_count = 0
        total_extract_ms = 0
        extract_count = 0
        total_tts_ms = 0
        tts_count = 0
        total_ms_sum = 0

        for r in records:
            prio = ((r.get("priority") or {}).get("level") or "MEDIUM").upper()
            priority_counts[prio] = priority_counts.get(prio, 0) + 1

            lang = r.get("original_language") or "Unknown"
            lang_counts[lang] = lang_counts.get(lang, 0) + 1

            ext = r.get("extraction") or {}
            inc = ext.get("incident_type") or "Unknown"
            if inc and inc != "Unknown":
                incident_counts[inc] = incident_counts.get(inc, 0) + 1

            loc = ext.get("location") or "Not identified"
            if loc and loc != "Not identified":
                location_counts[loc] = location_counts.get(loc, 0) + 1

            state = ext.get("caller_state") or "unknown"
            caller_states[state] = caller_states.get(state, 0) + 1

            if ext.get("weapon_mentioned"):
                weapon_present_count += 1
                wtype = ext.get("weapon_type") or "unspecified"
                weapon_types[wtype] = weapon_types.get(wtype, 0) + 1

            if ext.get("immediate_danger"):
                immediate_danger_count += 1

            if r.get("dispatched"):
                dispatched_count += 1

            timings = r.get("timings") or {}
            if "speech_ms" in timings and timings["speech_ms"]:
                total_speech_ms += timings["speech_ms"]
                speech_count += 1
            if "translate_ms" in timings and timings["translate_ms"]:
                total_translate_ms += timings["translate_ms"]
                translate_count += 1
            if "extract_ms" in timings and timings["extract_ms"]:
                total_extract_ms += timings["extract_ms"]
                extract_count += 1
            if "tts_ms" in timings and timings["tts_ms"]:
                total_tts_ms += timings["tts_ms"]
                tts_count += 1
            if "total_ms" in timings and timings["total_ms"]:
                total_ms_sum += timings["total_ms"]

        return {
            "total_records": total_records,
            "priority_breakdown": priority_counts,
            "language_distribution": lang_counts,
            "incident_types": incident_counts,
            "location_distribution": location_counts,
            "weapon_stats": {
                "present": weapon_present_count,
                "not_present": total_records - weapon_present_count,
                "types": weapon_types,
            },
            "immediate_danger_count": immediate_danger_count,
            "dispatched_count": dispatched_count,
            "caller_states": caller_states,
            "average_latencies": {
                "speech_ms": round(total_speech_ms / speech_count) if speech_count else 0,
                "translate_ms": round(total_translate_ms / translate_count) if translate_count else 0,
                "extract_ms": round(total_extract_ms / extract_count) if extract_count else 0,
                "tts_ms": round(total_tts_ms / tts_count) if tts_count else 0,
                "total_ms": round(total_ms_sum / total_records) if total_records else 0,
            },
        }

from __future__ import annotations

import base64
import time

from llm import LLMService
from sarvam_client import SarvamService, is_english, language_name


def _now() -> float:
    return time.perf_counter()


def _ms(started: float) -> int:
    return int((_now() - started) * 1000)


def fallback_extract(original_text: str, english_text: str) -> dict:
    blob = f"{original_text or ''}\n{english_text or ''}".lower()
    english = (english_text or original_text or "").lower()

    areas = [
        ("manish nagar", "Manish Nagar"),
        ("मानीश नगर", "Manish Nagar"),
        ("raj nagar", "Raj Nagar"),
        ("राज नगर", "Raj Nagar"),
        ("sitabuldi", "Sitabuldi"),
        ("सिताबुल्डी", "Sitabuldi"),
        ("dharampeth", "Dharampeth"),
        ("धर्मपेठ", "Dharampeth"),
        ("ramdaspeth", "Ramdaspeth"),
        ("sadar", "Sadar"),
        ("सदर", "Sadar"),
    ]
    area = "Not identified"
    for needle, label in areas:
        if needle.lower() in blob:
            area = label
            break

    weapon_type = None
    if any(token in blob for token in ["चाकू", "knife", "chakoo"]):
        weapon_type = "knife"
    elif any(token in blob for token in ["gun", "pistol", "पिस्तौल", "बंदूक"]):
        weapon_type = "gun"
    elif any(token in blob for token in ["रॉड", "rod"]):
        weapon_type = "rod"

    if any(token in blob for token in ["fire", "smoke", "आग", "धुआं"]):
        primary, secondary = "Fire", "Building fire"
    elif any(token in blob for token in ["accident", "दुर्घटना", "injured", "जख्मी"]):
        primary, secondary = "Traffic Accident", "Multiple injured"
    elif any(token in blob for token in ["chest", "ambulance", "एम्बुलन्स", "एम्बुलेंस", "breath", "छाती"]):
        primary, secondary = "Medical Emergency", "Chest pain / breathing"
    elif any(token in blob for token in ["theft", "चोरी", "robbery", "कैश", "dukan", "दुकान"]):
        primary = "Theft"
        secondary = "In progress" if any(token in blob for token in ["अभी", "now", "यहीं"]) else "Past incident"
    elif any(token in blob for token in ["husband", "पती", "domestic", "मारायला", "मार"]):
        primary, secondary = "Domestic Violence", "Assault with weapon" if weapon_type else "Assault"
    else:
        primary, secondary = "Unknown", ""

    immediate = bool(
        weapon_type
        or "fire" in english
        or "ambulance" in english
        or any(token in blob for token in ["अभी यहीं", "मारायला", "जख्मी"])
    )
    past_only = any(token in blob for token in ["कल रात", "yesterday", "रिपोर्ट दर्ज"])
    if past_only:
        immediate = False

    female_tokens = [
        "husband", "पती", "पति", "तिच्या", "मला मारायला", "husband beating",
        "wife", "woman", "girl", "lady", "स्त्री", "महिला", "आई", "mother",
        "daughter", "बहीण", "sister", "she", "her", "माझा नवरा", "नवरा"
    ]
    male_tokens = [
        "father", "बाबा", "बाबांना", "brother", "भाऊ", "wife", "बायको",
        "पत्नी", "man", "boy", "पुरुष", "दुकानदार", "he", "his", "him"
    ]
    caller_gender = "Unknown"
    if any(token in blob for token in female_tokens):
        caller_gender = "Female"
    elif any(token in blob for token in male_tokens):
        caller_gender = "Male"

    return {
        "location": {"area": area, "landmark": "", "address": "", "confidence": 0.7 if area != "Not identified" else 0.2, "notes": "keyword fallback"},
        "incident_type": {"primary": primary, "secondary": secondary, "confidence": 0.7, "keywords_found": []},
        "people_involved": {
            "victim": {"gender": caller_gender, "relationship_to_suspect": "", "status": "unknown", "description": ""},
            "suspect": {"gender": "Male" if caller_gender == "Female" and "husband" in blob else "Unknown", "relationship_to_victim": "", "status": "unknown", "description": ""},
            "witnesses": "",
            "total_people": "",
        },
        "weapon_mentioned": {
            "is_weapon_present": bool(weapon_type),
            "weapon_type": weapon_type,
            "confidence": 0.9 if weapon_type else 0.6,
            "context": "keyword match" if weapon_type else "none mentioned",
        },
        "immediate_danger": {
            "is_immediate_danger": immediate,
            "risk_level": 9 if immediate else 3,
            "danger_indicators": [primary] if immediate else [],
            "confidence": 0.7,
        },
        "distress_indicators": {
            "caller_state": "distressed" if immediate else "calm",
            "background_sounds": [],
            "confidence": 0.6,
        },
        "caller_gender": caller_gender,
        "summary": (english_text or original_text or "No transcript available")[:280],
    }


def json_safe(value):
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (str, int, float)):
        return value
    return str(value)


def apply_priority_overlay(extraction: dict, llm_priority: dict | None) -> dict:
    weapon = extraction.get("weapon_mentioned") or {}
    danger = extraction.get("immediate_danger") or {}
    distress = extraction.get("distress_indicators") or {}
    incident = extraction.get("incident_type") or {}

    weapon_present = bool(weapon.get("is_weapon_present"))
    immediate_danger = bool(danger.get("is_immediate_danger"))
    risk_level = int(danger.get("risk_level") or 0)
    caller_state = str(distress.get("caller_state") or "").lower()
    primary = str(incident.get("primary") or "").lower()

    rule_level = "LOW"
    rule_confidence = 0.75
    reasons = []

    if weapon_present or immediate_danger or risk_level >= 8:
        rule_level = "HIGH"
        rule_confidence = 0.95
        if weapon_present:
            reasons.append("weapon mentioned")
        if immediate_danger:
            reasons.append("immediate danger")
        if risk_level >= 8:
            reasons.append(f"risk level {risk_level}")
    elif caller_state in {"panicked", "crying", "distressed"} or "violence" in primary or "accident" in primary or "medical" in primary or "fire" in primary:
        rule_level = "MEDIUM"
        rule_confidence = 0.85
        reasons.append(caller_state or primary or "urgent indicators")
    else:
        reasons.append("no immediate threat indicators")

    llm_level = str((llm_priority or {}).get("priority_level") or "").upper()
    rank = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
    final_level = rule_level
    if llm_level in rank and rank[llm_level] > rank[rule_level]:
        final_level = llm_level

    if rule_level == "HIGH":
        final_level = "HIGH"

    confidence = (llm_priority or {}).get("confidence", rule_confidence)
    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = rule_confidence
    if rule_level == "HIGH":
        confidence = max(confidence, rule_confidence)

    decision_factors = list((llm_priority or {}).get("decision_factors") or [])
    for item in reasons:
        if item not in decision_factors:
            decision_factors.append(item)

    return {
        "level": final_level,
        "confidence": round(min(max(confidence, 0.0), 1.0), 2),
        "reasoning": (llm_priority or {}).get("explanation")
        or f"Based on: {', '.join(reasons)}",
        "decision_factors": decision_factors,
        "risk_factors": (llm_priority or {}).get("risk_factors") or reasons,
        "recommended_response": (llm_priority or {}).get("recommended_response")
        or _default_response(final_level, weapon_present),
        "dispatcher_notes": (llm_priority or {}).get("dispatcher_notes") or "",
        "time_critical": bool((llm_priority or {}).get("time_critical", final_level == "HIGH")),
        "rule_floor": rule_level,
    }


def _default_response(level: str, weapon_present: bool) -> str:
    if level == "HIGH" and weapon_present:
        return "2 police units plus ambulance, emergency dispatch"
    if level == "HIGH":
        return "Priority police response plus medical as needed"
    if level == "MEDIUM":
        return "1-2 police units, assess medical need"
    return "Single unit / report desk follow-up"


def flatten_extraction(extraction: dict) -> dict:
    location = extraction.get("location") or {}
    incident = extraction.get("incident_type") or {}
    people = extraction.get("people_involved") or {}
    victim = people.get("victim") or {}
    suspect = people.get("suspect") or {}
    weapon = extraction.get("weapon_mentioned") or {}
    danger = extraction.get("immediate_danger") or {}
    distress = extraction.get("distress_indicators") or {}

    victim_bits = [
        victim.get("gender"),
        victim.get("relationship_to_suspect"),
        victim.get("status"),
    ]
    people_label = ", ".join(str(bit) for bit in victim_bits if bit and str(bit).lower() != "unknown")
    if suspect.get("relationship_to_victim"):
        people_label = (people_label + f"; suspect: {suspect.get('relationship_to_victim')}").strip("; ")

    caller_gender = extraction.get("caller_gender") or victim.get("gender") or "Unknown"

    return {
        "location": location.get("area") or "Not identified",
        "landmark": location.get("landmark") or "",
        "address": location.get("address") or "",
        "incident_type": incident.get("primary") or "Unknown",
        "incident_secondary": incident.get("secondary") or "",
        "people_involved": people_label or people.get("total_people") or "Not specified",
        "weapon_mentioned": bool(weapon.get("is_weapon_present")),
        "weapon_type": weapon.get("weapon_type"),
        "immediate_danger": bool(danger.get("is_immediate_danger")),
        "risk_level": danger.get("risk_level"),
        "caller_state": distress.get("caller_state") or "unknown",
        "caller_gender": caller_gender,
        "summary": extraction.get("summary") or "",
        "raw": extraction,
    }



class RakshakPipeline:
    def __init__(self, sarvam: SarvamService | None = None, llm: LLMService | None = None):
        self.sarvam = sarvam or SarvamService()
        self.llm = llm or LLMService(self.sarvam)

    def process_text(self, transcript: str, source_hint: str | None = None) -> dict:
        started = _now()
        timings: dict[str, int] = {}

        t = _now()
        try:
            detected = self.sarvam.identify_language(transcript)
        except Exception:
            detected = {
                "language_code": "mr-IN" if (source_hint and "marathi" in source_hint.lower()) else None,
                "language": source_hint or "Marathi",
                "confidence": 0.0,
            }
        if source_hint and (not detected.get("language_code") or detected.get("language") == "Unknown"):
            detected["language"] = source_hint
        timings["language_ms"] = _ms(t)

        t = _now()
        try:
            english = self.sarvam.translate_to_english(
                transcript, detected.get("language_code")
            )
        except Exception:
            english = transcript

        try:
            marathi = self.sarvam.translate_to_marathi(
                transcript, detected.get("language_code")
            )
        except Exception:
            marathi = transcript
        timings["translate_ms"] = _ms(t)

        return self._extract_and_priority(
            transcript_original=transcript,
            transcript_english=english,
            transcript_marathi=marathi,
            language=detected.get("language") or "Marathi",
            language_code=detected.get("language_code") or "mr-IN",
            language_confidence=detected.get("confidence") or 0.0,
            timings=timings,
            started=started,
            source="text",
        )

    def process_audio(self, file_bytes: bytes, filename: str = "call.webm") -> dict:
        started = _now()
        timings: dict[str, int] = {}

        # Prepare original caller audio base64 data URI
        orig_audio_b64 = None
        if file_bytes:
            lower_fn = (filename or "").lower()
            mime = "audio/wav"
            if lower_fn.endswith(".webm"):
                mime = "audio/webm"
            elif lower_fn.endswith(".mp3"):
                mime = "audio/mp3"
            elif lower_fn.endswith(".m4a") or lower_fn.endswith(".mp4"):
                mime = "audio/mp4"
            elif lower_fn.endswith(".ogg"):
                mime = "audio/ogg"
            elif lower_fn.endswith(".wav"):
                mime = "audio/wav"
            orig_audio_b64 = f"data:{mime};base64,{base64.b64encode(file_bytes).decode('ascii')}"

        t = _now()
        try:
            speech = self.sarvam.transcribe_and_translate_audio(file_bytes, filename)
        except Exception as exc:
            timings["speech_ms"] = _ms(t)
            return self._extract_and_priority(
                transcript_original="",
                transcript_english="",
                transcript_marathi="",
                language="Marathi",
                language_code="mr-IN",
                language_confidence=0.0,
                timings=timings,
                started=started,
                source="audio",
                original_audio_base64=orig_audio_b64,
                note=f"Transcription failed: {exc}",
            )
        timings["speech_ms"] = _ms(t)

        original = speech.get("transcript_original") or ""
        english = speech.get("transcript_english") or original
        marathi = speech.get("transcript_marathi") or original

        if original and english and english.strip() == original.strip() and not is_english(speech.get("language_code")):
            t = _now()
            try:
                english = self.sarvam.translate_to_english(original, speech.get("language_code"))
            except Exception:
                pass
            timings["translate_ms"] = _ms(t)

        return self._extract_and_priority(
            transcript_original=original,
            transcript_english=english,
            transcript_marathi=marathi,
            language=speech.get("language") or language_name(speech.get("language_code")) or "Marathi",
            language_code=speech.get("language_code") or "mr-IN",
            language_confidence=speech.get("confidence") or 0.0,
            timings=timings,
            started=started,
            source="audio",
            original_audio_base64=orig_audio_b64,
        )

    def _extract_and_priority(
        self,
        transcript_original: str,
        transcript_english: str,
        transcript_marathi: str,
        language: str,
        language_code: str | None,
        language_confidence: float,
        timings: dict[str, int],
        started: float,
        source: str,
        original_audio_base64: str | None = None,
        note: str | None = None,
    ) -> dict:
        t = _now()
        extract_model = "rules"
        try:
            if transcript_original or transcript_english:
                extraction, extract_model = self.llm.extract(
                    transcript_original, transcript_english, language
                )
            else:
                extraction = fallback_extract("", note or "No speech detected in the recording.")
        except Exception:
            extraction = fallback_extract(transcript_original, transcript_english or note or "")
            extract_model = "rules"
        timings["extract_ms"] = _ms(t)

        t = _now()
        priority = apply_priority_overlay(extraction, None)
        timings["priority_ms"] = _ms(t)

        # Determine gender-appropriate voice (Female: priya, Male: shubh)
        caller_gender_val = str(extraction.get("caller_gender") or "").lower()
        victim_gender_val = str((extraction.get("people_involved") or {}).get("victim", {}).get("gender") or "").lower()
        combined_blob = f"{transcript_original} {transcript_english}".lower()
        
        is_female = (
            "female" in caller_gender_val
            or "female" in victim_gender_val
            or any(t in combined_blob for t in ["पती", "पति", "तिच्या", "husband", "woman", "wife", "स्त्री", "महिला", "मला मारायला"])
        )
        speaker = "priya" if is_female else "shubh"
        speaker_gender = "Female" if is_female else "Male"

        # Synthesize audio in Marathi (mr-IN) using Sarvam Bulbul TTS with matching gender
        audio_base64 = None
        t = _now()
        text_to_speak = transcript_marathi or transcript_original or transcript_english or ""
        if text_to_speak.strip():
            try:
                audio_base64 = self.sarvam.synthesize_speech(
                    text=text_to_speak,
                    language_code="mr-IN",
                    speaker=speaker,
                )
            except Exception:
                audio_base64 = None
        timings["tts_ms"] = _ms(t)
        timings["total_ms"] = _ms(started)

        if note and not extraction.get("summary"):
            extraction["summary"] = note

        return json_safe({
            "source": source,
            "original_language": language,
            "language_code": language_code,
            "language_confidence": float(language_confidence or 0),
            "transcript_original": transcript_original,
            "transcript_english": transcript_english,
            "transcript_marathi": transcript_marathi,
            "caller_gender": speaker_gender,
            "speaker_used": speaker,
            "speaker_gender": speaker_gender,
            "original_audio_base64": original_audio_base64,
            "translated_audio_base64": audio_base64,
            "extraction": flatten_extraction(extraction),
            "priority": priority,
            "timings": timings,
            "llm_used": extract_model,
        })




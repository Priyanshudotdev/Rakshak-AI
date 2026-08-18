"""Sarvam AI wrappers for language ID, translation, and speech-to-text."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from timeouts import run_with_timeout

STT_TIMEOUT_SEC = 35
TEXT_TIMEOUT_SEC = 25
TTS_TIMEOUT_SEC = 40

LANGUAGE_NAMES = {
    "as-IN": "Assamese",
    "bn-IN": "Bengali",
    "brx-IN": "Bodo",
    "doi-IN": "Dogri",
    "en-IN": "English",
    "en": "English",
    "gu-IN": "Gujarati",
    "hi-IN": "Hindi",
    "kn-IN": "Kannada",
    "ks-IN": "Kashmiri",
    "kok-IN": "Konkani",
    "mai-IN": "Maithili",
    "ml-IN": "Malayalam",
    "mni-IN": "Manipuri",
    "mr-IN": "Marathi",
    "ne-IN": "Nepali",
    "od-IN": "Odia",
    "pa-IN": "Punjabi",
    "sa-IN": "Sanskrit",
    "sat-IN": "Santali",
    "sd-IN": "Sindhi",
    "ta-IN": "Tamil",
    "te-IN": "Telugu",
    "ur-IN": "Urdu",
    "unknown": "Unknown",
}


def language_name(code: str | None) -> str:
    if not code:
        return "Unknown"
    return LANGUAGE_NAMES.get(code, code)


def is_english(code: str | None) -> bool:
    if not code:
        return False
    return code.lower() in {"en", "en-in", "en-us", "en-gb"}


class SarvamService:
    def __init__(self, api_key: str | None = None):
        key = (api_key or os.getenv("SARVAM_API_KEY") or "").strip().strip('"').strip("'")
        if not key:
            raise RuntimeError("SARVAM_API_KEY is not set")
        from sarvamai import SarvamAI

        self.client = SarvamAI(api_subscription_key=key)

    def identify_language(self, text: str) -> dict:
        sample = text[:1000]

        def _call():
            return self.client.text.identify_language(input=sample)

        response = run_with_timeout(_call, TEXT_TIMEOUT_SEC, "language detection")
        code = _attr(response, "language_code")
        script = _attr(response, "script_code")
        return {
            "language_code": code,
            "language": language_name(code),
            "script_code": script,
            "confidence": float(_attr(response, "language_probability") or 0.9),
        }

    def translate_to_english(self, text: str, source_language_code: str | None = None) -> str:
        if not text.strip():
            return text
        if is_english(source_language_code):
            return text
        source = source_language_code or "auto"
        if source == "unknown":
            source = "auto"
        model = "mayura:v1" if source == "auto" else "sarvam-translate:v1"

        def _call():
            return self.client.text.translate(
                input=text[:2000],
                source_language_code=source,
                target_language_code="en-IN",
                model=model,
            )

        response = run_with_timeout(_call, TEXT_TIMEOUT_SEC, "translation to english")
        return _attr(response, "translated_text") or _attr(response, "translatedText") or text

    def translate_to_marathi(self, text: str, source_language_code: str | None = None) -> str:
        if not text.strip():
            return text
        if source_language_code and source_language_code.lower() in {"mr", "mr-in"}:
            return text
        source = source_language_code or "auto"
        if source == "unknown":
            source = "auto"
        model = "mayura:v1" if source == "auto" else "sarvam-translate:v1"

        def _call():
            return self.client.text.translate(
                input=text[:2000],
                source_language_code=source,
                target_language_code="mr-IN",
                model=model,
            )

        try:
            response = run_with_timeout(_call, TEXT_TIMEOUT_SEC, "translation to marathi")
            return _attr(response, "translated_text") or _attr(response, "translatedText") or text
        except Exception:
            return text

    def transcribe_audio(self, file_bytes: bytes, filename: str = "call.webm") -> dict:
        path = _write_temp(file_bytes, filename)
        try:
            def _call():
                with open(path, "rb") as handle:
                    return self.client.speech_to_text.transcribe(
                        file=handle,
                        model="saaras:v3",
                        mode="transcribe",
                        language_code="unknown",
                    )

            response = run_with_timeout(_call, STT_TIMEOUT_SEC, "speech transcription")
            return _stt_payload(response)
        finally:
            Path(path).unlink(missing_ok=True)

    def transcribe_and_translate_audio(self, file_bytes: bytes, filename: str = "call.webm") -> dict:
        native = self.transcribe_audio(file_bytes, filename)
        original = native.get("transcript") or ""
        code = native.get("language_code")
        if original and not is_english(code):
            english = self.translate_to_english(original, code)
        else:
            english = original
        marathi = self.translate_to_marathi(original, code)
        return {
            "transcript_original": original,
            "transcript_english": english or original,
            "transcript_marathi": marathi or original,
            "language_code": code,
            "language": language_name(code),
            "confidence": float(native.get("confidence") or 0.0),
        }

    def synthesize_speech(
        self,
        text: str,
        language_code: str = "mr-IN",
        speaker: str = "shubh",
        model: str = "bulbul:v3",
    ) -> str | None:
        """Synthesize spoken audio from text using Sarvam Bulbul TTS in Marathi (mr-IN) or specified language.
        Returns a data URI string (data:audio/wav;base64,...) or None if failed.
        """
        clean_text = (text or "").strip()
        if not clean_text:
            return None

        # Valid TTS language codes for Sarvam
        valid_tts_langs = {
            "bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN",
            "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN"
        }
        target_lang = language_code if language_code in valid_tts_langs else "mr-IN"

        # Try full text first (up to 1500 chars)
        sample = clean_text[:1500]

        def _call_tts(text_chunk: str):
            def _worker():
                return self.client.text_to_speech.convert(
                    text=text_chunk,
                    language_code=target_lang,
                    speaker=speaker,
                    model=model,
                )
            return run_with_timeout(_worker, TTS_TIMEOUT_SEC, "speech synthesis")

        try:
            response = _call_tts(sample)
            audios = _attr(response, "audios")
            if audios and len(audios) > 0:
                b64 = audios[0]
                if b64.startswith("data:"):
                    return b64
                return f"data:audio/wav;base64,{b64}"
        except Exception:
            # Fallback to concise first sentence/chunk for fast guaranteed synthesis
            short_sample = clean_text[:300]
            try:
                response = _call_tts(short_sample)
                audios = _attr(response, "audios")
                if audios and len(audios) > 0:
                    b64 = audios[0]
                    if b64.startswith("data:"):
                        return b64
                    return f"data:audio/wav;base64,{b64}"
            except Exception:
                pass

        return None





def _attr(obj, name, default=None):
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _stt_payload(response) -> dict:
    code = _attr(response, "language_code")
    return {
        "transcript": _attr(response, "transcript") or "",
        "language_code": code,
        "language": language_name(code),
        "confidence": float(_attr(response, "language_probability") or 0.0),
        "request_id": _attr(response, "request_id"),
    }


def _write_temp(file_bytes: bytes, filename: str) -> str:
    suffix = Path(filename).suffix or ".webm"
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        handle.write(file_bytes)
        handle.flush()
        return handle.name
    finally:
        handle.close()


def bytes_from_upload(file_storage) -> tuple[bytes, str]:
    filename = getattr(file_storage, "filename", None) or "call.webm"
    data = file_storage.read()
    if hasattr(file_storage, "stream"):
        try:
            file_storage.stream.seek(0)
        except Exception:
            pass
    return data, filename

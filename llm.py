"""LLM extraction with Sarvam-105B primary and Gemini backup."""

from __future__ import annotations

import json
import os
import re

from prompts import EXTRACTION_PROMPT, PRIORITY_PROMPT
from timeouts import run_with_timeout

SARVAM_TIMEOUT_SEC = 12
GEMINI_TIMEOUT_SEC = 20
GEMINI_MODELS = ("gemini-2.5-flash", "gemini-2.0-flash")
SARVAM_CHAT_MODEL = "sarvam-105b"


def parse_json_from_text(text: str) -> dict:
    if not text:
        raise ValueError("Empty model response")
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
        raise ValueError("JSON was not an object")
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            parsed = json.loads(cleaned[start : end + 1])
            if isinstance(parsed, dict):
                return parsed
        raise


class LLMService:
    def __init__(self, sarvam_client, gemini_api_key: str | None = None):
        self.sarvam = sarvam_client
        raw = gemini_api_key if gemini_api_key is not None else os.getenv("GEMINI_API_KEY")
        self.gemini_api_key = (raw or "").strip().strip('"').strip("'")

    def extract(self, original_text: str, english_text: str, language: str) -> tuple[dict, str]:
        prompt = EXTRACTION_PROMPT.format(
            language=language or "Unknown",
            original_text=original_text or english_text,
            call_text=english_text or original_text,
        )
        return self._complete_json(prompt)

    def assess_priority(self, extraction: dict) -> tuple[dict, str]:
        prompt = PRIORITY_PROMPT.format(
            extraction_json=json.dumps(extraction, ensure_ascii=False, indent=2)
        )
        return self._complete_json(prompt)

    def _complete_json(self, prompt: str) -> tuple[dict, str]:
        errors = []
        try:
            text = self._sarvam_complete(prompt)
            return parse_json_from_text(text), "sarvam-105b"
        except Exception as exc:
            errors.append(f"sarvam: {exc}")
        try:
            text = self._gemini_complete(prompt)
            return parse_json_from_text(text), "gemini"
        except Exception as exc:
            errors.append(f"gemini: {exc}")
            raise RuntimeError(" | ".join(errors)) from exc

    def _sarvam_complete(self, prompt: str) -> str:
        def _call():
            response = self.sarvam.client.chat.completions(
                model=SARVAM_CHAT_MODEL,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=900,
            )
            return _message_text(response)

        return run_with_timeout(_call, SARVAM_TIMEOUT_SEC, "Sarvam chat")

    def _gemini_complete(self, prompt: str) -> str:
        if not self.gemini_api_key:
            raise RuntimeError("GEMINI_API_KEY is not set")

        def _call():
            from google import genai
            from google.genai import types

            client = genai.Client(
                api_key=self.gemini_api_key,
                http_options=types.HttpOptions(timeout=GEMINI_TIMEOUT_SEC * 1000),
            )
            last_error = None
            for model in GEMINI_MODELS:
                try:
                    response = client.models.generate_content(
                        model=model,
                        contents=prompt,
                        config=types.GenerateContentConfig(
                            response_mime_type="application/json",
                            temperature=0.2,
                            automatic_function_calling=types.AutomaticFunctionCallingConfig(
                                disable=True
                            ),
                        ),
                    )
                    text = getattr(response, "text", None)
                    if text:
                        return text
                    last_error = RuntimeError(f"{model} returned empty text")
                except Exception as exc:
                    last_error = exc
            raise RuntimeError(str(last_error) if last_error else "Gemini failed")

        return run_with_timeout(_call, GEMINI_TIMEOUT_SEC, "Gemini")


def _message_text(response) -> str:
    if response is None:
        raise RuntimeError("Empty Sarvam chat response")
    choices = getattr(response, "choices", None)
    if choices:
        message = getattr(choices[0], "message", None)
        if message is not None:
            content = getattr(message, "content", None)
            if isinstance(content, str) and content.strip():
                return content
            if isinstance(content, list):
                parts = []
                for part in content:
                    if isinstance(part, str):
                        parts.append(part)
                    else:
                        parts.append(getattr(part, "text", "") or "")
                joined = "".join(parts).strip()
                if joined:
                    return joined
    if isinstance(response, dict):
        try:
            return response["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            pass
    raise RuntimeError("Could not read Sarvam chat content")

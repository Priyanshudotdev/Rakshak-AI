import os
import traceback
from datetime import datetime, timezone

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

from memory import MemoryStore
from pipeline import RakshakPipeline, json_safe
from sarvam_client import bytes_from_upload

load_dotenv()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

DISPATCH_LOG: list[dict] = []
_pipeline: RakshakPipeline | None = None


def get_pipeline() -> RakshakPipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = RakshakPipeline()
    return _pipeline


@app.route("/")
def index():
    return render_template("dashboard.html")


@app.route("/api/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "sarvam": bool(os.getenv("SARVAM_API_KEY")),
            "gemini": bool(os.getenv("GEMINI_API_KEY")),
        }
    )


@app.route("/api/process-call", methods=["POST"])
def process_call():
    data = request.get_json(silent=True) or {}
    transcript = (data.get("transcript") or "").strip()
    if not transcript:
        return jsonify({"status": "error", "message": "Transcript is required"}), 400
    try:
        result = get_pipeline().process_text(transcript, source_hint=data.get("language"))
        result["call_id"] = f"LIVE-{datetime.now(timezone.utc).strftime('%H%M%S')}"
        result["scenario"] = "Manual Transcript Incident"

        # Automatically store in persistent memory
        saved = MemoryStore.save_record(result)
        result["id"] = saved["id"]

        return jsonify({"status": "success", "data": json_safe(result)})
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(exc) or exc.__class__.__name__}), 500


@app.route("/api/process-audio", methods=["POST"])
def process_audio():
    upload = request.files.get("file")
    if not upload:
        return jsonify({"status": "error", "message": "Audio file is required"}), 400
    file_bytes, filename = bytes_from_upload(upload)
    if not file_bytes:
        return jsonify({"status": "error", "message": "Audio file was empty"}), 400
    try:
        result = get_pipeline().process_audio(file_bytes, filename)
        result["call_id"] = f"AUDIO-{datetime.now(timezone.utc).strftime('%H%M%S')}"
        result["scenario"] = f"Voice Recording ({filename})"

        # Automatically store in persistent memory
        saved = MemoryStore.save_record(result)
        result["id"] = saved["id"]

        return jsonify({"status": "success", "data": json_safe(result)})
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(exc) or exc.__class__.__name__}), 500


@app.route("/api/records", methods=["GET", "DELETE"])
def records():
    if request.method == "DELETE":
        count = MemoryStore.clear_all()
        return jsonify({"status": "success", "message": f"Cleared {count} records"})

    query = request.args.get("q")
    priority = request.args.get("priority")
    language = request.args.get("language")
    limit = int(request.args.get("limit", 100))
    offset = int(request.args.get("offset", 0))

    items = MemoryStore.get_records(
        query=query,
        priority=priority,
        language=language,
        limit=limit,
        offset=offset,
    )
    return jsonify({"status": "success", "data": json_safe(items), "count": len(items)})


@app.route("/api/records/<record_id>", methods=["GET", "DELETE"])
def record_detail(record_id):
    if request.method == "DELETE":
        deleted = MemoryStore.delete_record(record_id)
        if not deleted:
            return jsonify({"status": "error", "message": "Record not found"}), 404
        return jsonify({"status": "success", "message": "Record deleted"})

    item = MemoryStore.get_record(record_id)
    if not item:
        return jsonify({"status": "error", "message": "Record not found"}), 404
    return jsonify({"status": "success", "data": json_safe(item)})


@app.route("/api/analytics", methods=["GET"])
def analytics():
    summary = MemoryStore.get_analytics()
    return jsonify({"status": "success", "data": json_safe(summary)})


@app.route("/api/tts", methods=["POST"])
def tts():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"status": "error", "message": "Text is required"}), 400
    language_code = data.get("language_code", "mr-IN")
    speaker = data.get("speaker", "shubh")
    record_id = data.get("record_id") or data.get("call_id")
    try:
        pipeline = get_pipeline()
        audio_b64 = pipeline.sarvam.synthesize_speech(
            text=text,
            language_code=language_code,
            speaker=speaker,
        )
        if not audio_b64:
            return jsonify({"status": "error", "message": "Speech synthesis returned no audio"}), 500

        if record_id:
            rec = MemoryStore.get_record(record_id)
            if rec:
                rec["translated_audio_base64"] = audio_b64
                rec["speaker_used"] = speaker
                MemoryStore.save_record(rec)

        return jsonify({"status": "success", "data": {"audio_base64": audio_b64, "speaker": speaker, "language_code": language_code}})
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(exc) or exc.__class__.__name__}), 500



@app.route("/api/dispatch", methods=["GET", "POST"])
def dispatch():
    if request.method == "GET":
        return jsonify(DISPATCH_LOG)

    data = request.get_json(silent=True) or {}
    call_id = data.get("call_id") or "LIVE"
    entry = {
        "id": f"DSP-{len(DISPATCH_LOG) + 1:03d}",
        "time": datetime.now(timezone.utc).astimezone().strftime("%H:%M:%S"),
        "call_id": call_id,
        "location": data.get("location") or "Not identified",
        "incident_type": data.get("incident_type") or "Unknown",
        "priority": data.get("priority") or "MEDIUM",
        "units": data.get("units") or "Patrol unit assigned",
    }
    DISPATCH_LOG.insert(0, entry)

    # Also update dispatch info in memory record if matching
    MemoryStore.update_record_dispatch(call_id, entry)

    return jsonify({"status": "success", "data": entry, "log": DISPATCH_LOG})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "1") == "1"
    app.run(debug=debug, port=port, threaded=True)

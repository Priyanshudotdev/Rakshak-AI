const STAGES = ["detect", "transcribe", "translate", "extract", "tts", "priority"];
const MAX_RECORD_SEC = 25;

const els = {
  // Navigation
  tabBtns: document.querySelectorAll(".tab-btn"),
  tabViews: document.querySelectorAll(".tab-view"),
  recordsCountBadge: document.getElementById("records-count-badge"),
  clock: document.getElementById("clock"),

  // Live Intake & Docket
  recordBtn: document.getElementById("record-btn"),
  recordTimer: document.getElementById("record-timer"),
  audioDropzone: document.getElementById("audio-dropzone"),
  audioFile: document.getElementById("audio-file"),
  audioName: document.getElementById("audio-name"),
  transcript: document.getElementById("call-transcript"),
  processText: document.getElementById("process-text-btn"),
  pipeline: document.getElementById("pipeline"),
  status: document.getElementById("status-line"),
  error: document.getElementById("error-line"),
  docket: document.getElementById("docket"),
  empty: document.getElementById("empty-state"),
  skeleton: document.getElementById("skeleton"),
  incident: document.getElementById("incident"),
  originalAudioCard: document.getElementById("original-audio-card"),
  originalAudioPlayer: document.getElementById("original-audio-player"),
  originalAudioTag: document.getElementById("original-audio-tag"),
  sarvamAudioCard: document.getElementById("sarvam-audio-card"),
  sarvamAudioPlayer: document.getElementById("sarvam-audio-player"),
  audioLangTag: document.getElementById("audio-lang-tag"),
  resynthesizeAudioBtn: document.getElementById("resynthesize-audio-btn"),
  dispatchBtn: document.getElementById("dispatch-btn"),
  dispatchNote: document.getElementById("dispatch-note"),
  dispatchLog: document.getElementById("dispatch-log"),

  // Memory Records
  recordSearch: document.getElementById("record-search"),
  priorityFilters: document.getElementById("priority-filters"),
  languageFilter: document.getElementById("language-filter"),
  recordsGrid: document.getElementById("records-grid"),
  recordsLoading: document.getElementById("records-loading"),
  recordsEmpty: document.getElementById("records-empty"),
  exportRecordsBtn: document.getElementById("export-records-btn"),
  clearRecordsBtn: document.getElementById("clear-records-btn"),

  // Analytics
  refreshAnalyticsBtn: document.getElementById("refresh-analytics-btn"),
  kpiTotal: document.getElementById("kpi-total"),
  kpiHighPrio: document.getElementById("kpi-high-prio"),
  kpiDispatched: document.getElementById("kpi-dispatched"),
  kpiWeapons: document.getElementById("kpi-weapons"),
  kpiLatency: document.getElementById("kpi-latency"),
  priorityBars: document.getElementById("priority-bars"),
  incidentBars: document.getElementById("incident-bars"),
  languageBars: document.getElementById("language-bars"),
  locationBars: document.getElementById("location-bars"),
  latSpeech: document.getElementById("lat-speech"),
  latTranslate: document.getElementById("lat-translate"),
  latExtract: document.getElementById("lat-extract"),
  latTts: document.getElementById("lat-tts"),
  latTotal: document.getElementById("lat-total"),

  // Modal
  recordModal: document.getElementById("record-modal"),
  modalTitle: document.getElementById("modal-title"),
  modalSubtitle: document.getElementById("modal-subtitle"),
  modalBody: document.getElementById("modal-body"),
  modalCloseBtn: document.getElementById("modal-close-btn"),
};

let currentResult = null;
let mediaRecorder = null;
let recordChunks = [];
let recordTimerId = null;
let recordSeconds = 0;
let stageTimerId = null;
let busy = false;
let activePriorityFilter = "ALL";

document.addEventListener("DOMContentLoaded", () => {
  tickClock();
  setInterval(tickClock, 1000);

  // Setup tabs
  setupTabs();

  // Setup Drag and Drop Audio File
  setupAudioDropzone();

  // Load initial data
  loadDispatchLog();
  updateRecordsBadge();

  // Live intake event listeners
  els.recordBtn.addEventListener("click", toggleRecord);
  els.audioFile.addEventListener("change", onFilePicked);
  els.processText.addEventListener("click", processManualCall);
  els.dispatchBtn.addEventListener("click", confirmDispatch);
  if (els.resynthesizeAudioBtn) {
    els.resynthesizeAudioBtn.addEventListener("click", resynthesizeCurrentVoice);
  }


  // Memory Records event listeners
  els.recordSearch.addEventListener("input", debounce(filterAndRenderRecords, 300));
  els.priorityFilters.addEventListener("click", onPriorityFilterClick);
  els.languageFilter.addEventListener("change", filterAndRenderRecords);
  els.exportRecordsBtn.addEventListener("click", exportRecordsJson);
  els.clearRecordsBtn.addEventListener("click", clearMemoryRecords);

  // Analytics event listeners
  els.refreshAnalyticsBtn.addEventListener("click", loadAnalytics);

  // Modal event listeners
  els.modalCloseBtn.addEventListener("click", () => els.recordModal.close());
  els.recordModal.addEventListener("click", (e) => {
    if (e.target === els.recordModal) els.recordModal.close();
  });
});

/* =========================================================================
   NAVIGATION & CLOCK
   ========================================================================= */
function tickClock() {
  const now = new Date();
  els.clock.dateTime = now.toISOString();
  els.clock.textContent = now.toLocaleTimeString("en-IN", { hour12: false });
}

function setupTabs() {
  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.tab;
      els.tabBtns.forEach((b) => b.classList.remove("active"));
      els.tabViews.forEach((v) => {
        v.hidden = true;
        v.classList.remove("active");
      });

      btn.classList.add("active");
      const targetView = document.getElementById(targetId);
      if (targetView) {
        targetView.hidden = false;
        targetView.classList.add("active");
      }

      if (targetId === "records-tab") {
        loadMemoryRecords();
      } else if (targetId === "analytics-tab") {
        loadAnalytics();
      }
    });
  });
}

/* =========================================================================
   AUDIO DRAG & DROP
   ========================================================================= */
function setupAudioDropzone() {
  if (!els.audioDropzone || !els.audioFile) return;

  // Click to open file dialog
  els.audioDropzone.addEventListener("click", () => {
    if (!busy) els.audioFile.click();
  });

  // Keyboard accessibility
  els.audioDropzone.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !busy) {
      e.preventDefault();
      els.audioFile.click();
    }
  });

  // Drag over events
  ["dragenter", "dragover"].forEach((eventName) => {
    els.audioDropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!busy) els.audioDropzone.classList.add("is-dragover");
    });
  });

  // Drag leave events
  ["dragleave", "dragend"].forEach((eventName) => {
    els.audioDropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.audioDropzone.classList.remove("is-dragover");
    });
  });

  // Drop event
  els.audioDropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.audioDropzone.classList.remove("is-dragover");
    if (busy) return;

    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;

    const file = files[0];
    const isAudio = file.type.startsWith("audio/") || /\.(webm|wav|mp3|m4a|ogg)$/i.test(file.name);
    if (!isAudio) {
      showError("Please drop a valid audio file (WAV, MP3, M4A, OGG, or WebM).");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      showError("Audio file exceeds the 10MB limit.");
      return;
    }

    els.audioName.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    await sendAudio(file, file.name);
  });
}

/* =========================================================================
   LIVE INTAKE & PROCESSING PIPELINE
   ========================================================================= */
async function processManualCall() {
  const transcript = els.transcript.value.trim();
  if (!transcript) {
    showError("Paste a transcript first.");
    return;
  }
  await runPipeline(() =>
    fetchJson("/api/process-call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
    })
  );
}

async function onFilePicked(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  els.audioName.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
  await sendAudio(file, file.name);
  event.target.value = "";
}


async function toggleRecord() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    stopRecording();
    return;
  }
  if (busy) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const mime = pickAudioMime();
    mediaRecorder = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);
    recordChunks = [];
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size) recordChunks.push(event.data);
    };
    mediaRecorder.onerror = () => {
      showError("Recording failed in the browser.");
    };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const type = mediaRecorder.mimeType || mime || "audio/webm";
      const blob = new Blob(recordChunks, { type });
      if (!blob.size) {
        showError("Recording was empty. Hold Record for at least one second, then Stop.");
        return;
      }
      const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      await sendAudio(blob, `live-call.${ext}`);
    };
    mediaRecorder.start(250);
    recordSeconds = 0;
    els.recordBtn.classList.add("recording");
    els.recordBtn.innerHTML = '<i class="ph ph-stop" aria-hidden="true"></i> Stop';
    updateTimer();
    recordTimerId = setInterval(() => {
      recordSeconds += 1;
      updateTimer();
      if (recordSeconds >= MAX_RECORD_SEC) stopRecording();
    }, 1000);
  } catch (err) {
    showError("Microphone access was denied or is unavailable.");
  }
}

function pickAudioMime() {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return types.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || "";
}

function stopRecording() {
  if (recordTimerId) {
    clearInterval(recordTimerId);
    recordTimerId = null;
  }
  els.recordBtn.classList.remove("recording");
  els.recordBtn.innerHTML = '<i class="ph ph-microphone" aria-hidden="true"></i> Record';
  if (mediaRecorder && mediaRecorder.state === "recording") {
    try {
      mediaRecorder.requestData();
    } catch (err) {
      // ignore
    }
    mediaRecorder.stop();
  }
}

function updateTimer() {
  els.recordTimer.textContent = `${formatSec(recordSeconds)} / ${formatSec(MAX_RECORD_SEC)}`;
}

async function sendAudio(blob, filename) {
  const form = new FormData();
  form.append("file", blob, filename);
  await runPipeline(() =>
    fetchJson("/api/process-audio", { method: "POST", body: form })
  );
}

async function runPipeline(requestFn) {
  if (busy) return;
  busy = true;
  setBusyUi(true);
  hideError();
  showLoading();
  startStageAnimation();
  try {
    const payload = await requestFn();
    if (payload.status !== "success" || !payload.data) {
      throw new Error(payload.message || "Processing failed");
    }
    completeStages();
    displayResults(payload.data);
    updateRecordsBadge();
    els.status.textContent = `Processed successfully in ${payload.data.timings?.total_ms ?? "?"} ms (Stored to Memory)`;
  } catch (err) {
    failStages();
    showError(err.message || "Processing failed");
    showEmpty();
  } finally {
    busy = false;
    setBusyUi(false);
    stopStageAnimation();
  }
}

function setBusyUi(isBusy) {
  els.processText.disabled = isBusy;
  els.dispatchBtn.disabled = isBusy || !currentResult;
  els.audioFile.disabled = isBusy;
  const recording = mediaRecorder && mediaRecorder.state === "recording";
  els.recordBtn.disabled = isBusy && !recording;
}

function startStageAnimation() {
  stopStageAnimation();
  let index = 0;
  setStageState(STAGES[0], "is-active");
  stageTimerId = setInterval(() => {
    if (index < STAGES.length) {
      setStageState(STAGES[index], "is-done");
    }
    index += 1;
    if (index < STAGES.length) {
      setStageState(STAGES[index], "is-active");
    }
  }, 600);
}

function completeStages() {
  STAGES.forEach((stage) => setStageState(stage, "is-done"));
}

function failStages() {
  document.querySelectorAll("#pipeline li").forEach((li) => {
    li.classList.remove("is-active", "is-done");
    li.classList.add("is-failed");
  });
}

function stopStageAnimation() {
  if (stageTimerId) {
    clearInterval(stageTimerId);
    stageTimerId = null;
  }
}

function setStageState(stage, className) {
  const li = document.querySelector(`[data-stage="${stage}"]`);
  if (!li) return;
  li.classList.remove("is-active", "is-done", "is-failed");
  if (className) li.classList.add(className);
}

function resetStages() {
  document.querySelectorAll("#pipeline li").forEach((li) => {
    li.classList.remove("is-active", "is-done", "is-failed");
  });
}

function showLoading() {
  resetStages();
  els.empty.hidden = true;
  els.incident.hidden = true;
  els.skeleton.hidden = false;
  els.docket.classList.remove("is-empty", "is-high", "is-medium", "is-low");
  els.status.textContent = "Processing emergency intake...";
  els.dispatchBtn.disabled = true;
}

function showEmpty() {
  els.skeleton.hidden = true;
  els.incident.hidden = true;
  els.empty.hidden = false;
  currentResult = null;
  els.dispatchBtn.disabled = true;
}

function displayResults(data) {
  currentResult = data;
  els.skeleton.hidden = true;
  els.empty.hidden = true;
  els.incident.hidden = false;

  const extraction = data.extraction || {};
  const priority = data.priority || {};
  const level = (priority.level || "MEDIUM").toLowerCase();

  els.docket.classList.remove("is-high", "is-medium", "is-low");
  els.docket.classList.add(`is-${level}`);

  document.getElementById("incident-id").textContent =
    data.id || data.call_id || `NGP-112`;
  document.getElementById("incident-scenario").textContent =
    data.scenario || "Active Emergency Call";

  const badge = document.getElementById("priority-badge");
  badge.textContent = `${priority.level || "MEDIUM"} PRIORITY`;
  badge.className = `priority-badge ${level}`;

  document.getElementById("summary").textContent = extraction.summary || "No summary returned.";
  document.getElementById("location").textContent = formatLocation(extraction);
  document.getElementById("incident-type").textContent = [
    extraction.incident_type,
    extraction.incident_secondary,
  ].filter(Boolean).join(" / ") || "Unknown";
  document.getElementById("people-involved").textContent = extraction.people_involved || "Not specified";
  document.getElementById("weapon").textContent = extraction.weapon_mentioned
    ? `Yes${extraction.weapon_type ? ` (${extraction.weapon_type})` : ""}`
    : "No";
  document.getElementById("danger").textContent = extraction.immediate_danger ? "Yes (Active Danger)" : "No";
  document.getElementById("caller-state").textContent = extraction.caller_state || "unknown";
  // Intelligent non-duplicate transcript column display
  const origText = (data.transcript_original || "").trim();
  const marathiText = (data.transcript_marathi || "").trim();
  const englishText = (data.transcript_english || "").trim();
  const langCode = String(data.language_code || "").toLowerCase();
  const origLang = String(data.original_language || "").toLowerCase();

  const isOrigMarathi = langCode.startsWith("mr") || origLang.includes("marathi") || (origText && marathiText && origText === marathiText);
  const isOrigEnglish = langCode.startsWith("en") || origLang.includes("english") || (origText && englishText && origText === englishText);

  const colOriginal = document.getElementById("col-original");
  const colMarathi = document.getElementById("col-marathi");
  const colEnglish = document.getElementById("col-english");
  const container = document.getElementById("transcripts-container");

  document.getElementById("transcript-original").textContent = origText || "No original transcript available.";
  const marathiEl = document.getElementById("transcript-marathi");
  if (marathiEl) marathiEl.textContent = marathiText || origText || "";
  document.getElementById("transcript-english").textContent = englishText || "";

  if (isOrigMarathi) {
    if (colMarathi) colMarathi.hidden = true;
    if (colEnglish) colEnglish.hidden = false;
    if (container) {
      container.classList.remove("split-three");
      container.style.gridTemplateColumns = "1fr 1fr";
    }
  } else if (isOrigEnglish) {
    if (colEnglish) colEnglish.hidden = true;
    if (colMarathi) colMarathi.hidden = false;
    if (container) {
      container.classList.remove("split-three");
      container.style.gridTemplateColumns = "1fr 1fr";
    }
  } else {
    if (colMarathi) colMarathi.hidden = false;
    if (colEnglish) colEnglish.hidden = false;
    if (container) {
      container.classList.add("split-three");
      container.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
    }
  }

  document.getElementById("language-meta").textContent = [
    data.original_language,
    data.language_code,
    data.language_confidence != null
      ? `${Math.round(Number(data.language_confidence) * 100)}% conf`
      : "",
  ].filter(Boolean).join(" · ");

  document.getElementById("response-rec").textContent = priority.recommended_response || "Review and assign unit";
  document.getElementById("confidence").textContent = `${Math.round((priority.confidence || 0) * 100)}%`;
  document.getElementById("reasoning").textContent = priority.reasoning || "";
  document.getElementById("llm-meta").textContent = `Extraction Engine: ${data.llm_used || "Gemini / Rules"}`;

  const timings = data.timings || {};
  document.getElementById("latency-meta").textContent = `Latencies: STT ${timings.speech_ms || 0}ms | Translate ${timings.translate_ms || 0}ms | Extract ${timings.extract_ms || 0}ms | TTS ${timings.tts_ms || 0}ms | Total ${timings.total_ms || 0}ms`;

  // 1. Original Caller Audio Setup
  if (data.original_audio_base64) {
    els.originalAudioCard.hidden = false;
    els.originalAudioPlayer.src = data.original_audio_base64;
    els.originalAudioPlayer.load();
    if (els.originalAudioTag) {
      els.originalAudioTag.textContent = `${data.original_language || "Incoming"} Call Recording`;
    }
  } else {
    els.originalAudioCard.hidden = true;
    els.originalAudioPlayer.src = "";
  }

  // 2. Sarvam Marathi Translated Audio Setup
  if (data.translated_audio_base64) {
    els.sarvamAudioCard.hidden = false;
    els.sarvamAudioPlayer.src = data.translated_audio_base64;
    els.sarvamAudioPlayer.load();
    if (els.audioLangTag) {
      const gender = data.speaker_gender || (data.extraction && data.extraction.caller_gender) || "Voice";
      const spk = data.speaker_used || (gender.toLowerCase() === "female" ? "priya" : "shubh");
      els.audioLangTag.textContent = `Marathi (mr-IN) · ${gender} Voice (${spk})`;
    }
  } else {
    els.sarvamAudioCard.hidden = true;
    els.sarvamAudioPlayer.src = "";
  }

  // Adjust audio grid column layout
  const audioGrid = document.getElementById("audio-players-grid");
  if (audioGrid) {
    if (data.original_audio_base64 && data.translated_audio_base64) {
      audioGrid.style.gridTemplateColumns = "1fr 1fr";
    } else {
      audioGrid.style.gridTemplateColumns = "1fr";
    }
  }

  els.dispatchBtn.disabled = false;
  els.dispatchNote.textContent = priority.dispatcher_notes || "Confirm unit mobilization after docket review.";
}

async function resynthesizeCurrentVoice() {
  if (!currentResult) return;
  const text = currentResult.transcript_marathi || currentResult.transcript_original || currentResult.transcript_english;
  if (!text) {
    showError("No transcript available to synthesize.");
    return;
  }
  const isFemale = String(currentResult.speaker_gender || "").toLowerCase() === "female" || String((currentResult.extraction || {}).caller_gender || "").toLowerCase() === "female";
  const speaker = isFemale ? "priya" : "shubh";
  if (els.resynthesizeAudioBtn) {
    els.resynthesizeAudioBtn.disabled = true;
    els.resynthesizeAudioBtn.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Generating...';
  }
  try {
    const payload = await fetchJson("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        language_code: "mr-IN",
        speaker,
        record_id: currentResult.id || currentResult.call_id,
      }),
    });
    if (payload.status === "success" && payload.data && payload.data.audio_base64) {
      currentResult.translated_audio_base64 = payload.data.audio_base64;
      els.sarvamAudioCard.hidden = false;
      els.sarvamAudioPlayer.src = payload.data.audio_base64;
      els.sarvamAudioPlayer.load();
      els.sarvamAudioPlayer.play().catch(() => {});
      if (els.audioLangTag) {
        els.audioLangTag.textContent = `Marathi (mr-IN) · ${isFemale ? "Female" : "Male"} Voice (${speaker})`;
      }
      updateRecordsBadge();
    }
  } catch (err) {
    showError(err.message || "Failed to synthesize voice audio.");
  } finally {
    if (els.resynthesizeAudioBtn) {
      els.resynthesizeAudioBtn.disabled = false;
      els.resynthesizeAudioBtn.innerHTML = '<i class="ph ph-arrows-clockwise"></i> Re-generate';
    }
  }
}

function formatLocation(extraction) {
  return [extraction.location, extraction.landmark, extraction.address]
    .filter((part) => part && part !== "Not identified")
    .join(", ") || "Not identified";
}

async function confirmDispatch() {
  if (!currentResult) return;
  const extraction = currentResult.extraction || {};
  const priority = currentResult.priority || {};
  const units = priority.recommended_response || "Patrol unit assigned";
  try {
    const payload = await fetchJson("/api/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call_id: currentResult.id || currentResult.call_id || "LIVE",
        location: formatLocation(extraction),
        incident_type: extraction.incident_type,
        priority: priority.level,
        units,
      }),
    });
    renderDispatchLog(payload.log || [payload.data]);
    els.dispatchNote.textContent = `Dispatched ${payload.data.id} (${units})`;
    updateRecordsBadge();
  } catch (err) {
    showError(err.message || "Dispatch failed");
  }
}

async function loadDispatchLog() {
  try {
    const log = await fetchJson("/api/dispatch");
    renderDispatchLog(log);
  } catch (err) {
    // ignore
  }
}

function renderDispatchLog(log) {
  els.dispatchLog.innerHTML = "";
  if (!log || !log.length) {
    els.dispatchLog.innerHTML = '<li class="log-empty">No units tasked yet</li>';
    return;
  }
  log.forEach((entry) => {
    const li = document.createElement("li");
    const level = (entry.priority || "").toLowerCase();
    li.innerHTML = `
      <div class="prio ${escapeHtml(level)}">${escapeHtml(entry.priority)} · ${escapeHtml(entry.time)}</div>
      <div>${escapeHtml(entry.location)}</div>
      <div class="hint">${escapeHtml(entry.units)}</div>
    `;
    els.dispatchLog.appendChild(li);
  });
}

/* =========================================================================
   TAB 2: INCIDENT RECORDS (MEMORY)
   ========================================================================= */
let cachedRecords = [];

async function updateRecordsBadge() {
  try {
    const res = await fetchJson("/api/records?limit=1");
    if (res && res.data) {
      const all = await fetchJson("/api/records");
      const count = all.data ? all.data.length : 0;
      els.recordsCountBadge.textContent = count;
    }
  } catch (e) {
    // ignore
  }
}

async function loadMemoryRecords() {
  els.recordsLoading.hidden = false;
  els.recordsEmpty.hidden = true;
  els.recordsGrid.innerHTML = "";
  try {
    const res = await fetchJson("/api/records");
    cachedRecords = res.data || [];
    els.recordsCountBadge.textContent = cachedRecords.length;
    filterAndRenderRecords();
  } catch (err) {
    showError("Could not load memory records.");
  } finally {
    els.recordsLoading.hidden = true;
  }
}

function onPriorityFilterClick(e) {
  const btn = e.target.closest(".pill-btn");
  if (!btn) return;
  els.priorityFilters.querySelectorAll(".pill-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  activePriorityFilter = btn.dataset.priority || "ALL";
  filterAndRenderRecords();
}

function filterAndRenderRecords() {
  const query = (els.recordSearch.value || "").toLowerCase().trim();
  const lang = els.languageFilter.value;

  let filtered = cachedRecords.filter((r) => {
    // Priority filter
    const p = ((r.priority && r.priority.level) || "MEDIUM").toUpperCase();
    if (activePriorityFilter !== "ALL" && p !== activePriorityFilter) return false;

    // Language filter
    const l = (r.original_language || "").toLowerCase();
    if (lang !== "ALL" && !l.includes(lang.toLowerCase())) return false;

    // Search query
    if (query) {
      const ext = r.extraction || {};
      const haystack = [
        r.id,
        r.scenario,
        r.transcript_original,
        r.transcript_english,
        ext.location,
        ext.landmark,
        ext.incident_type,
        ext.summary,
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    return true;
  });

  renderRecordsGrid(filtered);
}

function renderRecordsGrid(records) {
  els.recordsGrid.innerHTML = "";
  if (!records || records.length === 0) {
    els.recordsEmpty.hidden = false;
    return;
  }
  els.recordsEmpty.hidden = true;

  records.forEach((record) => {
    const ext = record.extraction || {};
    const prio = record.priority || {};
    const level = (prio.level || "MEDIUM").toLowerCase();
    const hasOriginalAudio = Boolean(record.original_audio_base64);
    const hasMarathiAudio = Boolean(record.translated_audio_base64);

    const card = document.createElement("article");
    card.className = `record-card prio-${level}`;
    card.innerHTML = `
      <div class="record-card-top">
        <div>
          <h4 class="record-card-title">${escapeHtml(record.scenario || "Incident Call")}</h4>
          <span class="mono hint">${escapeHtml(record.id)} · ${escapeHtml(record.timestamp_formatted || "")}</span>
        </div>
        <span class="priority-badge ${level}">${escapeHtml(prio.level || "MEDIUM")}</span>
      </div>

      <div class="record-meta-chips">
        <span class="chip"><i class="ph ph-map-pin"></i> ${escapeHtml(ext.location || "Unknown")}</span>
        <span class="chip"><i class="ph ph-warning-octagon"></i> ${escapeHtml(ext.incident_type || "Incident")}</span>
        <span class="chip"><i class="ph ph-translate"></i> ${escapeHtml(record.original_language || "Native")}</span>
        ${ext.weapon_mentioned ? `<span class="chip weapon"><i class="ph ph-knife"></i> Weapon: ${escapeHtml(ext.weapon_type || "Yes")}</span>` : ""}
        ${ext.immediate_danger ? `<span class="chip alert"><i class="ph ph-shield-warning"></i> Danger</span>` : ""}
        ${record.dispatched ? `<span class="chip" style="background:var(--low-bg);color:#86efac"><i class="ph ph-check-circle"></i> Dispatched</span>` : ""}
      </div>

      <p class="record-summary-text">${escapeHtml(ext.summary || record.transcript_english || record.transcript_original || "No summary available.")}</p>

      ${(hasOriginalAudio || hasMarathiAudio) ? `
        <div class="record-audio-preview-group" style="display:flex;flex-direction:column;gap:6px;margin:8px 0;">
          ${hasOriginalAudio ? `
            <div class="record-audio-preview" style="background:#131822;padding:6px 10px;border-radius:6px;border:1px solid #232d3d;">
              <div style="font-size:11px;color:#38bdf8;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:4px;">
                <i class="ph ph-waveform"></i> Original Caller Audio
              </div>
              <audio controls preload="none" src="${record.original_audio_base64}" style="width:100%;height:30px;"></audio>
            </div>
          ` : ""}
          ${hasMarathiAudio ? `
            <div class="record-audio-preview" style="background:#171e29;padding:6px 10px;border-radius:6px;border:1px solid #2b384a;">
              <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:4px;">
                <i class="ph ph-speaker-high"></i> Marathi Voice (${escapeHtml(record.speaker_gender || ext.caller_gender || "Voice")})
              </div>
              <audio controls preload="none" src="${record.translated_audio_base64}" style="width:100%;height:30px;"></audio>
            </div>
          ` : ""}
        </div>
      ` : ""}

      <div class="record-card-actions">
        <button type="button" class="btn btn-secondary view-detail-btn" style="padding:6px 12px;font-size:12px;">
          <i class="ph ph-eye"></i> View Full Docket
        </button>
        <button type="button" class="btn btn-danger-outline delete-record-btn" style="padding:6px 10px;font-size:12px;" title="Delete Record">
          <i class="ph ph-trash"></i>
        </button>
      </div>
    `;

    card.querySelector(".view-detail-btn").addEventListener("click", () => openRecordModal(record));
    card.querySelector(".delete-record-btn").addEventListener("click", () => deleteRecord(record.id));

    els.recordsGrid.appendChild(card);
  });
}

function openRecordModal(record) {
  const ext = record.extraction || {};
  const prio = record.priority || {};
  const level = (prio.level || "MEDIUM").toLowerCase();
  const timings = record.timings || {};

  els.modalTitle.textContent = `${record.id} · ${prio.level || "MEDIUM"} PRIORITY`;
  els.modalSubtitle.textContent = `${record.scenario || "Incident"} · Recorded on ${record.timestamp_formatted || ""}`;

  els.modalBody.innerHTML = `
    <div style="margin-bottom:16px;">
      <p class="summary" style="margin:0 0 14px;">${escapeHtml(ext.summary || "No summary.")}</p>
      
      <dl class="facts" style="margin-bottom:16px;">
        <div><dt>Location</dt><dd>${escapeHtml(formatLocation(ext))}</dd></div>
        <div><dt>Incident Category</dt><dd>${escapeHtml(ext.incident_type || "Unknown")} / ${escapeHtml(ext.incident_secondary || "")}</dd></div>
        <div><dt>People Involved</dt><dd>${escapeHtml(ext.people_involved || "Not specified")}</dd></div>
        <div><dt>Weapon Present</dt><dd>${ext.weapon_mentioned ? `Yes (${escapeHtml(ext.weapon_type || "Yes")})` : "No"}</dd></div>
        <div><dt>Immediate Danger</dt><dd>${ext.immediate_danger ? "Yes" : "No"}</dd></div>
        <div><dt>Caller State</dt><dd>${escapeHtml(ext.caller_state || "unknown")}</dd></div>
      </dl>

      <!-- Modal Audio Players -->
      ${(record.original_audio_base64 || record.translated_audio_base64) ? `
        <div class="audio-players-grid" style="margin-bottom:16px;">
          ${record.original_audio_base64 ? `
            <div class="audio-player-card original-audio-card">
              <div class="audio-player-header">
                <div class="audio-player-title"><i class="ph ph-waveform"></i> Original Caller Audio</div>
                <span class="audio-tag">Original Recording</span>
              </div>
              <audio controls src="${record.original_audio_base64}" style="width:100%;height:36px;"></audio>
            </div>
          ` : ""}
          ${record.translated_audio_base64 ? `
            <div class="audio-player-card marathi-audio-card">
              <div class="audio-player-header">
                <div class="audio-player-title"><i class="ph ph-speaker-high"></i> Marathi Voice Broadcast</div>
                <span class="audio-tag">Marathi (mr-IN) · ${escapeHtml(record.speaker_gender || ext.caller_gender || "Voice")}</span>
              </div>
              <audio controls src="${record.translated_audio_base64}" style="width:100%;height:36px;"></audio>
            </div>
          ` : ""}
        </div>
      ` : ""}

      ${(() => {
        const modalOrig = (record.transcript_original || "").trim();
        const modalMarathi = (record.transcript_marathi || "").trim();
        const modalEnglish = (record.transcript_english || "").trim();
        const mCode = String(record.language_code || "").toLowerCase();
        const mLang = String(record.original_language || "").toLowerCase();

        const isMOrigMarathi = mCode.startsWith("mr") || mLang.includes("marathi") || (modalOrig && modalMarathi && modalOrig === modalMarathi);
        const isMOrigEnglish = mCode.startsWith("en") || mLang.includes("english") || (modalOrig && modalEnglish && modalOrig === modalEnglish);

        if (isMOrigMarathi) {
          return `
            <div class="split-copy" style="grid-template-columns: 1fr 1fr; margin-bottom:16px;">
              <section>
                <h3>Original Speech (Marathi · मराठी)</h3>
                <p class="transcript">${escapeHtml(modalOrig)}</p>
              </section>
              <section>
                <h3>English Translation</h3>
                <p class="transcript">${escapeHtml(modalEnglish || "No translation available")}</p>
              </section>
            </div>
          `;
        } else if (isMOrigEnglish) {
          return `
            <div class="split-copy" style="grid-template-columns: 1fr 1fr; margin-bottom:16px;">
              <section>
                <h3>Original Speech (English)</h3>
                <p class="transcript">${escapeHtml(modalOrig)}</p>
              </section>
              <section>
                <h3>Marathi (मराठी) Translation</h3>
                <p class="transcript">${escapeHtml(modalMarathi || "No translation available")}</p>
              </section>
            </div>
          `;
        } else {
          return `
            <div class="split-copy split-three" style="margin-bottom:16px;">
              <section>
                <h3>Original (${escapeHtml(record.original_language || "Native")})</h3>
                <p class="transcript">${escapeHtml(modalOrig)}</p>
              </section>
              <section>
                <h3>Marathi (मराठी) Translation</h3>
                <p class="transcript">${escapeHtml(modalMarathi || modalOrig)}</p>
              </section>
              <section>
                <h3>English Translation</h3>
                <p class="transcript">${escapeHtml(modalEnglish || "No translation available")}</p>
              </section>
            </div>
          `;
        }
      })()}

      <div class="priority-block">
        <h3>Tactical Recommendation</h3>
        <p><span class="label">Response:</span> <strong>${escapeHtml(prio.recommended_response || "Patrol dispatch")}</strong></p>
        <p><span class="label">Confidence:</span> ${Math.round((prio.confidence || 0) * 100)}%</p>
        <p><span class="label">Reasoning:</span> ${escapeHtml(prio.reasoning || "")}</p>
        <div class="meta-row" style="font-size:11px;">
          <span>Engine: ${escapeHtml(record.llm_used || "Gemini")}</span>
          <span class="mono">Total Latency: ${timings.total_ms || 0} ms</span>
        </div>
      </div>
    </div>
  `;

  els.recordModal.showModal();
}

async function deleteRecord(recordId) {
  if (!confirm(`Are you sure you want to delete incident record ${recordId}?`)) return;
  try {
    await fetchJson(`/api/records/${recordId}`, { method: "DELETE" });
    cachedRecords = cachedRecords.filter((r) => r.id !== recordId);
    els.recordsCountBadge.textContent = cachedRecords.length;
    filterAndRenderRecords();
  } catch (err) {
    showError("Failed to delete record.");
  }
}

async function clearMemoryRecords() {
  if (!confirm("Are you sure you want to CLEAR ALL records from memory? This cannot be undone.")) return;
  try {
    await fetchJson("/api/records", { method: "DELETE" });
    cachedRecords = [];
    els.recordsCountBadge.textContent = "0";
    filterAndRenderRecords();
  } catch (err) {
    showError("Failed to clear memory records.");
  }
}

function exportRecordsJson() {
  if (!cachedRecords || !cachedRecords.length) {
    showError("No records to export.");
    return;
  }
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(cachedRecords, null, 2));
  const downloadAnchor = document.createElement("a");
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `rakshak_incident_records_${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

/* =========================================================================
   TAB 3: INTELLIGENCE & ANALYTICS
   ========================================================================= */
async function loadAnalytics() {
  els.refreshAnalyticsBtn.disabled = true;
  try {
    const res = await fetchJson("/api/analytics");
    if (!res || !res.data) throw new Error("Could not compute analytics");
    renderAnalytics(res.data);
  } catch (err) {
    showError("Failed to load analytics.");
  } finally {
    els.refreshAnalyticsBtn.disabled = false;
  }
}

function renderAnalytics(data) {
  const total = data.total_records || 0;
  const prio = data.priority_breakdown || { HIGH: 0, MEDIUM: 0, LOW: 0 };
  const lat = data.average_latencies || {};

  els.kpiTotal.textContent = total;
  els.kpiHighPrio.textContent = `${prio.HIGH || 0} (${total ? Math.round((prio.HIGH / total) * 100) : 0}%)`;
  els.kpiDispatched.textContent = data.dispatched_count || 0;
  els.kpiWeapons.textContent = (data.weapon_stats && data.weapon_stats.present) || 0;
  els.kpiLatency.textContent = `${lat.total_ms || 0} ms`;

  // Priority Bars
  renderStatBars(els.priorityBars, [
    { label: "HIGH PRIORITY", count: prio.HIGH || 0, total, colorClass: "high" },
    { label: "MEDIUM PRIORITY", count: prio.MEDIUM || 0, total, colorClass: "medium" },
    { label: "LOW PRIORITY", count: prio.LOW || 0, total, colorClass: "low" },
  ]);

  // Incident Types Bars
  const incidents = Object.entries(data.incident_types || {}).map(([name, count]) => ({
    label: name,
    count,
    total,
    colorClass: "accent",
  }));
  renderStatBars(els.incidentBars, incidents.length ? incidents : [{ label: "No data yet", count: 0, total: 1, colorClass: "accent" }]);

  // Language Bars
  const languages = Object.entries(data.language_distribution || {}).map(([name, count]) => ({
    label: name,
    count,
    total,
    colorClass: "blue",
  }));
  renderStatBars(els.languageBars, languages.length ? languages : [{ label: "No data yet", count: 0, total: 1, colorClass: "blue" }]);

  // Location Bars
  const locations = Object.entries(data.location_distribution || {}).map(([name, count]) => ({
    label: name,
    count,
    total,
    colorClass: "purple",
  }));
  renderStatBars(els.locationBars, locations.length ? locations : [{ label: "No data yet", count: 0, total: 1, colorClass: "purple" }]);

  // Latency Breakdown
  els.latSpeech.textContent = `${lat.speech_ms || 0} ms`;
  els.latTranslate.textContent = `${lat.translate_ms || 0} ms`;
  els.latExtract.textContent = `${lat.extract_ms || 0} ms`;
  els.latTts.textContent = `${lat.tts_ms || 0} ms`;
  els.latTotal.textContent = `${lat.total_ms || 0} ms`;
}

function renderStatBars(container, items) {
  container.innerHTML = "";
  items.forEach((item) => {
    const pct = item.total > 0 ? Math.round((item.count / item.total) * 100) : 0;
    const row = document.createElement("div");
    row.className = "stat-row";
    row.innerHTML = `
      <div class="stat-row-meta">
        <span>${escapeHtml(item.label)}</span>
        <span class="mono">${item.count} (${pct}%)</span>
      </div>
      <div class="stat-bar-track">
        <div class="stat-bar-fill ${item.colorClass || 'accent'}" style="width:${pct}%"></div>
      </div>
    `;
    container.appendChild(row);
  });
}

/* =========================================================================
   UTILITIES
   ========================================================================= */
async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let payload = {};
    try {
      payload = await response.json();
    } catch (err) {
      payload = {};
    }
    if (!response.ok) {
      throw new Error(payload.message || `Request failed (${response.status})`);
    }
    return payload;
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("Request timed out. Please try again.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function showError(message) {
  els.error.hidden = false;
  els.error.textContent = message;
}

function hideError() {
  els.error.hidden = true;
  els.error.textContent = "";
}

function formatSec(value) {
  return `00:${String(value).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function debounce(fn, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), wait);
  };
}

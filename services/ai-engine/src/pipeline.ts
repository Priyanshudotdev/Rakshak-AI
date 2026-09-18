import { Buffer } from "node:buffer";
import { assessPriority, extract } from "./llm.js";
import { fallbackExtract } from "./fallback.js";
import { isEnglish, languageName } from "./languages.js";
import { applyPriorityOverlay } from "./priority.js";
import { identifyLanguage, synthesizeSpeech, transcribeAndTranslateAudio, translateToEnglish, translateToMarathi } from "./sarvam.js";

export interface Timings extends Record<string, number> {}

function msSince(start: number): number {
  return Date.now() - start;
}

export function flattenExtraction(extraction: any) {
  const location = extraction?.location ?? {};
  const incident = extraction?.incident_type ?? {};
  const people = extraction?.people_involved ?? {};
  const victim = people?.victim ?? {};
  const suspect = people?.suspect ?? {};
  const weapon = extraction?.weapon_mentioned ?? {};
  const danger = extraction?.immediate_danger ?? {};
  const distress = extraction?.distress_indicators ?? {};

  const bits = [victim.gender, victim.relationship_to_suspect, victim.status].filter((b) => b && String(b).toLowerCase() !== "unknown");
  let peopleLabel = bits.join(", ");
  if (suspect.relationship_to_victim) peopleLabel = `${peopleLabel}; suspect: ${suspect.relationship_to_victim}`.replace(/^; /, "");

  return {
    location: location.area || "Not identified",
    landmark: location.landmark || "",
    address: location.address || "",
    incident_type: incident.primary || "Unknown",
    incident_secondary: incident.secondary || "",
    people_involved: peopleLabel || people.total_people || "Not specified",
    weapon_mentioned: Boolean(weapon.is_weapon_present),
    weapon_type: weapon.weapon_type ?? null,
    immediate_danger: Boolean(danger.is_immediate_danger),
    risk_level: danger.risk_level ?? null,
    caller_state: distress.caller_state || "unknown",
    caller_gender: extraction?.caller_gender || victim.gender || "Unknown",
    summary: extraction?.summary || "",
    raw: extraction,
  };
}

function pickSpeaker(extraction: any, original: string, english: string): { speaker: string; speakerGender: string } {
  const caller = String(extraction?.caller_gender ?? "").toLowerCase();
  const victim = String(extraction?.people_involved?.victim?.gender ?? "").toLowerCase();
  const explicit = caller || victim;
  if (explicit.includes("female")) return { speaker: "priya", speakerGender: "Female" };
  if (explicit.includes("male")) return { speaker: "shubh", speakerGender: "Male" };
  const blob = `${original} ${english}`.toLowerCase();
  const femaleHints = ["माझा पती", "माझा नवरा", "my husband", "मेरा पति", "मेरा पती", "तिच्या", "woman", "girl", "lady", "स्त्री", "महिला", "आई", "mother", "daughter", "बहीण", "sister"];
  const maleHints = ["माझी बायको", "माझी पत्नी", "my wife", "मेरी पत्नी", "father", "बाबा", "बाबांना", "brother", "भाऊ", "man", "boy", "पुरुष", "दुकानदार"];
  const isFemale = femaleHints.some((t) => blob.includes(t)) && !maleHints.some((t) => blob.includes(t));
  return isFemale ? { speaker: "priya", speakerGender: "Female" } : { speaker: "shubh", speakerGender: "Male" };
}

async function extractAndPriority(opts: {
  original: string; english: string; marathi: string;
  language: string; languageCode?: string; languageConfidence: number;
  timings: Timings; started: number; source: string; originalAudioBase64?: string | null; note?: string | null;
}) {
  const { original, english, marathi, language, languageCode, languageConfidence, timings, started, source, originalAudioBase64, note } = opts;

  let t = Date.now();
  let extraction: any;
  let extractModel = "rules";
  try {
    if (original || english) {
      const res = await extract(original, english, language);
      extraction = res.data; extractModel = res.model;
    } else {
      extraction = fallbackExtract("", note ?? "No speech detected in the recording.");
    }
  } catch {
    extraction = fallbackExtract(original, english || note || "");
  }
  timings.extract_ms = msSince(t);

  t = Date.now();
  let priority = applyPriorityOverlay(extraction, null);
  if (priority.rule_floor !== "HIGH" && (original || english)) {
    try {
      const res = await assessPriority(extraction);
      priority = applyPriorityOverlay(extraction, res.data);
    } catch { /* keep rule floor */ }
  }
  timings.priority_ms = msSince(t);

  const { speaker, speakerGender } = pickSpeaker(extraction, original, english);

  t = Date.now();
  const textToSpeak = marathi || original || english || "";
  let audioBase64: string | null = null;
  if (textToSpeak.trim()) {
    try {
      audioBase64 = await synthesizeSpeech(textToSpeak, "mr-IN", speaker);
    } catch { audioBase64 = null; }
  }
  timings.tts_ms = msSince(t);
  timings.total_ms = Date.now() - started;

  if (note && !extraction.summary) extraction.summary = note;
  return {
    source,
    original_language: language,
    language_code: languageCode ?? "mr-IN",
    language_confidence: Number(languageConfidence ?? 0),
    transcript_original: original,
    transcript_english: english,
    transcript_marathi: marathi,
    caller_gender: speakerGender,
    speaker_used: speaker,
    speaker_gender: speakerGender,
    original_audio_base64: originalAudioBase64 ?? null,
    translated_audio_base64: audioBase64,
    extraction: flattenExtraction(extraction),
    priority,
    timings,
    llm_used: extractModel,
  };
}

export async function processText(transcript: string, sourceHint?: string) {
  const started = Date.now();
  const timings: Timings = {};
  let t = Date.now();
  let detected: { language_code?: string; language: string; confidence: number };
  try {
    const d = await identifyLanguage(transcript);
    detected = { language_code: d.language_code, language: d.language, confidence: d.confidence };
  } catch {
    detected = {
      language_code: sourceHint?.toLowerCase().includes("marathi") ? "mr-IN" : undefined,
      language: sourceHint || "Marathi",
      confidence: 0,
    };
  }
  if (sourceHint && (!detected.language_code || detected.language === "Unknown")) detected.language = sourceHint;
  timings.language_ms = msSince(t);

  t = Date.now();
  let english: string;
  try { english = await translateToEnglish(transcript, detected.language_code); } catch { english = transcript; }
  let marathi: string;
  try { marathi = await translateToMarathi(transcript, detected.language_code); } catch { marathi = transcript; }
  timings.translate_ms = msSince(t);

  return extractAndPriority({
    original: transcript, english, marathi,
    language: detected.language || "Marathi",
    languageCode: detected.language_code || "mr-IN",
    languageConfidence: detected.confidence || 0,
    timings, started, source: "text",
  });
}

function mimeFor(filename: string): string {
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".mp3")) return "audio/mp3";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "audio/wav";
}

export async function processAudio(fileBytes: Uint8Array, filename = "call.webm") {
  const started = Date.now();
  const timings: Timings = {};
  const origAudioB64 = fileBytes.length
    ? `data:${mimeFor(filename)};base64,${Buffer.from(fileBytes).toString("base64")}`
    : null;

  const t = Date.now();
  try {
    const speech = await transcribeAndTranslateAudio(fileBytes, filename);
    timings.speech_ms = msSince(t);
    let english = speech.transcript_english || speech.transcript_original;
    if (speech.transcript_original && english.trim() === speech.transcript_original.trim() && !isEnglish(speech.language_code)) {
      const t2 = Date.now();
      try { english = await translateToEnglish(speech.transcript_original, speech.language_code); } catch { /* keep */ }
      timings.translate_ms = msSince(t2);
    }
    return extractAndPriority({
      original: speech.transcript_original, english,
      marathi: speech.transcript_marathi || speech.transcript_original,
      language: speech.language || languageName(speech.language_code) || "Marathi",
      languageCode: speech.language_code || "mr-IN",
      languageConfidence: speech.confidence || 0,
      timings, started, source: "audio", originalAudioBase64: origAudioB64,
    });
  } catch (err) {
    timings.speech_ms = msSince(t);
    return extractAndPriority({
      original: "", english: "", marathi: "",
      language: "Marathi", languageCode: "mr-IN", languageConfidence: 0,
      timings, started, source: "audio", originalAudioBase64: origAudioB64,
      note: `Transcription failed: ${err}`,
    });
  }
}

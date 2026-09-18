import type { AriController } from "./ari.js";

// Two-way translated conversation (spec §5): who hears what, in which tongue.
// Pure routing logic with injected I/O so the matrix is unit-testable without
// phones: caller finals drive incidents + caller-tongue replies + operator
// translation; operator finals translate toward the caller tongue only and
// never create incidents.

export interface ConversationDeps {
  ari(): AriController | null;
  apiUrl: string;
  fetchFn?: typeof fetch;
  log(level: string, msg: string, fields?: Record<string, unknown>): void;
  operatorLang: string;
}

/** Reply voice follows the CALLER's language: Marathi, Hindi or English —
 *  detected per utterance, Marathi default. */
export function replyVoice(language?: string): { code: string; ack: string; confirm: (incident?: string) => string } {
  const lang = (language ?? "").toLowerCase();
  if (lang.startsWith("hi") || lang.includes("hindi")) {
    return {
      code: "hi-IN",
      ack: "जानकारी मिल गई है, जाँच रहे हैं।",
      confirm: (incident) =>
        incident && incident !== "Unknown"
          ? `आपकी रिपोर्ट दर्ज हो गई है। ${incident} के लिए मदद भेज रहे हैं।`
          : "आपकी रिपोर्ट दर्ज हो गई है, मदद जल्द पहुँचेगी।",
    };
  }
  if (lang.startsWith("en") || lang.includes("english")) {
    return {
      code: "en-IN",
      ack: "Got it, checking now.",
      confirm: (incident) =>
        incident && incident !== "Unknown"
          ? `Your report is recorded. Help is on the way for the ${incident}.`
          : "Your report is recorded, help will arrive soon.",
    };
  }
  return {
    code: "mr-IN",
    ack: "माहिती मिळाली, तपासत आहे.",
    confirm: (incident) =>
      incident && incident !== "Unknown"
        ? `आपली तक्रार नोंदवली आहे. ${incident} साठी मदत पाठवत आहोत.`
        : "आपली तक्रार नोंदवली आहे, मदत लवकरच पोहोचेल.",
  };
}

/** Below this detection confidence we don't trust a language switch. */
const MIN_LANG_CONFIDENCE = 0.6;

export function createConversation(deps: ConversationDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  /** Last detected language per call — routes operator speech toward it. */
  const langByCall = new Map<string, string>();

  async function speak(channelId: string, text: string, languageCode = "mr-IN"): Promise<void> {
    const ari = deps.ari();
    if (!ari) return;
    await ari.playReply(channelId, text, languageCode);
  }

  async function translateAndSpeak(channelId: string, text: string, targetCode: string, source?: string): Promise<void> {
    try {
      const res = await fetchFn(`${deps.apiUrl}/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, target_language_code: targetCode, source_language_code: source }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { data?: { translated_text?: string } };
      const translated = body.data?.translated_text?.trim();
      if (translated) await speak(channelId, translated, targetCode);
    } catch (err) {
      deps.log("warn", "translate-speak failed", { channelId, err: String(err) });
    }
  }

  async function handleFinal(callId: string, text: string, language: string | undefined, role: string, confidence?: number): Promise<void> {
    const ari = deps.ari();
    if (!ari || !text.trim()) return;
    // Sarvam misdetects tongues on noisy lines (observed: Marathi caller read
    // as en-IN @ 0.4). Below-confidence guesses fall back to the call's
    // established tongue, else the Marathi default — never a shaky first guess.
    const prior = langByCall.get(callId);
    let effLang = language;
    if (language && confidence !== undefined && confidence < MIN_LANG_CONFIDENCE) {
      effLang = prior ?? "Marathi";
      deps.log("info", "language fallback", { callId, detected: language, confidence, using: effLang });
    }
    if (effLang) langByCall.set(callId, effLang);
    const channelId = ari.channelForCall(callId);
    if (!channelId) return;
    if (role === "operator") {
      const peer = ari.bridgePeer(callId);
      const callerLang = (peer && langByCall.get(peer.callId)) || "Marathi";
      const callerChannel = peer ? ari.channelForCall(peer.callId) : null;
      if (!callerChannel) return;
      await translateAndSpeak(callerChannel, text, replyVoice(callerLang).code, effLang);
      return;
    }
    const voice = replyVoice(effLang);
    try {
      await speak(channelId, voice.ack, voice.code);
      const res = await fetchFn(`${deps.apiUrl}/api/process-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text, language: effLang ?? "Marathi" }),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          data?: { extraction?: { incident_type?: string }; priority?: { level?: string } };
        };
        await speak(channelId, voice.confirm(body.data?.extraction?.incident_type), voice.code);
      }
      // Same bridge, other ear: operator hears the caller translated.
      const peer = ari.bridgePeer(callId);
      if (peer && peer.role === "operator") {
        const opChannel = ari.channelForCall(peer.callId);
        if (opChannel) await translateAndSpeak(opChannel, text, deps.operatorLang, effLang);
      }
    } catch (err) {
      deps.log("warn", "final-loop failed", { callId, err: String(err) });
    }
  }

  return { handleFinal, replyVoice, langByCall };
}

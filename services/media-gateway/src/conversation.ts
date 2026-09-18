import type { AriController } from "./ari.js";

// Two-way translated conversation (spec §5): who hears what, in which tongue.
// Pure routing logic with injected I/O so the matrix is unit-testable without
// phones: caller finals drive incidents + caller-tongue replies + operator
// translation; operator finals translate toward the caller tongue only and
// never create incidents.

export interface OperatorProfile {
  operator_id: string;
  default_language: string;
  known_languages: string[];
}

export interface ConversationDeps {
  ari(): AriController | null;
  apiUrl: string;
  fetchFn?: typeof fetch;
  log(level: string, msg: string, fields?: Record<string, unknown>): void;
  operatorLang: string;
  publish?: (name: string, callId: string, payload: unknown) => void;
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

/** Toggle cache TTL: GET /api/calls/:id/translation is hot per utterance. */
const TOGGLE_TTL_MS = 2000;

function normLang(s: string): string {
  const l = String(s ?? "").toLowerCase().trim();
  if (!l) return "";
  if (l.includes("marathi") || l.startsWith("mr")) return "mr";
  if (l.includes("hindi") || l.startsWith("hi")) return "hi";
  if (l.includes("english") || l.startsWith("en")) return "en";
  return l.slice(0, 2);
}

/** True when the caller tongue is already covered by the operator's known list. */
export function isKnownTongue(tongue: string | undefined, known: string[]): boolean {
  const t = normLang(tongue ?? "");
  if (!t) return false;
  return (known ?? []).some((k) => normLang(k) === t);
}

export function createConversation(deps: ConversationDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  /** Last detected language per call — routes operator speech toward it. */
  const langByCall = new Map<string, string>();
  /** Translation toggle per call: callId -> {enabled, expiresAt} (2s TTL). */
  const toggleCache = new Map<string, { enabled: boolean; expiresAt: number }>();
  /** Operator profile per caller call: cached at join. */
  const profileByCall = new Map<string, OperatorProfile>();
  /** Calls already nudged with translation.suggested (once per call). */
  const nudged = new Set<string>();

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

  /** Cache an operator profile for a caller call (called at join). */
  function setOperatorProfile(callerCallId: string, profile: OperatorProfile): void {
    if (!callerCallId || !profile?.operator_id) return;
    profileByCall.set(callerCallId, {
      operator_id: profile.operator_id,
      default_language: profile.default_language || deps.operatorLang,
      known_languages: Array.isArray(profile.known_languages) ? [...profile.known_languages] : [],
    });
  }

  function getOperatorProfile(callerCallId: string): OperatorProfile | null {
    return profileByCall.get(callerCallId) ?? null;
  }

  /** Clear per-call caches (toggle entries, nudged flags, profile, tongue). */
  function clearCallState(callId: string): void {
    langByCall.delete(callId);
    toggleCache.delete(callId);
    profileByCall.delete(callId);
    nudged.delete(callId);
  }

  /** Translation toggle for a call (2s TTL cache, default false on error). */
  async function isTranslationEnabled(callId: string): Promise<boolean> {
    const now = Date.now();
    const cached = toggleCache.get(callId);
    if (cached && cached.expiresAt > now) return cached.enabled;
    if (cached) toggleCache.delete(callId);
    try {
      const res = await fetchFn(`${deps.apiUrl}/api/calls/${encodeURIComponent(callId)}/translation`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { enabled?: unknown; data?: { enabled?: unknown } };
      const enabled = (body as { enabled?: unknown }).enabled ?? (body as { data?: { enabled?: unknown } }).data?.enabled ?? false;
      const flag = enabled === true;
      toggleCache.set(callId, { enabled: flag, expiresAt: Date.now() + TOGGLE_TTL_MS });
      return flag;
    } catch (err) {
      deps.log("warn", "translation toggle fetch failed", { callId, err: String(err) });
      return false;
    }
  }

  function resolveProfile(callerCallId: string, operatorCallId?: string): OperatorProfile | null {
    const direct = profileByCall.get(callerCallId);
    if (direct) return direct;
    // Pull-through from the gateway cache (ARI owns lookup profiles at join).
    try {
      const ari = deps.ari() as unknown as {
        getOperatorProfile?: (id: string) => OperatorProfile | null;
      } | null;
      if (ari && typeof ari.getOperatorProfile === "function") {
        const viaCaller = ari.getOperatorProfile(callerCallId);
        if (viaCaller?.operator_id) {
          profileByCall.set(callerCallId, viaCaller);
          return viaCaller;
        }
        if (operatorCallId) {
          const viaOp = ari.getOperatorProfile(operatorCallId);
          if (viaOp?.operator_id) {
            profileByCall.set(callerCallId, viaOp);
            return viaOp;
          }
        }
      }
    } catch {
      /* ignore */
    }
    return null;
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
      // Rendition policy (single rendition, never stacked): profile + known
      // tongue -> direct talk, silence; profile + unknown + toggle ON is
      // rendered by the toggle block below; otherwise legacy rendition.
      const peer = ari.bridgePeer(callId);
      if (peer && peer.role === "operator") {
        const opChannel = ari.channelForCall(peer.callId);
        const prof = resolveProfile(callId, peer.callId);
        const tongue0 = effLang ?? prior ?? "Marathi";
        const toggleOn = prof?.operator_id ? await isTranslationEnabled(callId) : false;
        if (!opChannel) {
          /* nowhere to render */
        } else if (prof?.operator_id && isKnownTongue(tongue0, prof.known_languages ?? [])) {
          // Direct talk — engine stays out of the audio.
        } else if (!(prof?.operator_id && toggleOn)) {
          await translateAndSpeak(opChannel, text, deps.operatorLang, effLang);
        }
      }
    } catch (err) {
      deps.log("warn", "final-loop failed", { callId, err: String(err) });
    }
    // Caller->operator rendition (translation toggle): AFTER the existing
    // logic so emergency replies never depend on it.
    try {
      const peer = ari.bridgePeer(callId);
      if (!peer || peer.role !== "operator") return;
      const opChannel = ari.channelForCall(peer.callId);
      if (!opChannel) return;
      const profile = resolveProfile(callId, peer.callId);
      if (!profile?.operator_id) return;
      const tongue = effLang ?? prior ?? "Marathi";
      if (isKnownTongue(tongue, profile.known_languages ?? [])) return;
      const enabled = await isTranslationEnabled(callId);
      if (enabled) {
        const target = profile.default_language || deps.operatorLang;
        await translateAndSpeak(opChannel, text, target, effLang);
      } else if (!nudged.has(callId)) {
        nudged.add(callId);
        try {
          deps.publish?.("translation.suggested", callId, {
            call_id: callId,
            caller_language: tongue,
            operator_id: profile.operator_id,
          });
        } catch {
          /* publish must never break the loop */
        }
      }
    } catch (err) {
      deps.log("warn", "translation rendition failed", { callId, err: String(err) });
    }
  }

  return {
    handleFinal,
    replyVoice,
    langByCall,
    setOperatorProfile,
    getOperatorProfile,
    clearCallState,
    isTranslationEnabled,
    toggleCache,
    profileByCall,
    nudged,
  };
}

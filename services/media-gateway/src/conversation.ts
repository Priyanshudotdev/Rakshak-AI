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

  /** Cache an operator profile for a caller call (called at join).
   *  Triggers one conferencing enforcement pass (fire-and-forget,
   *  warn-never-break): toggle defaults false => conference immediately so the
   *  joiner hears the live call at once. */
  function setOperatorProfile(callerCallId: string, profile: OperatorProfile): void {
    if (!callerCallId || !profile?.operator_id) return;
    profileByCall.set(callerCallId, {
      operator_id: profile.operator_id,
      default_language: profile.default_language || deps.operatorLang,
      known_languages: Array.isArray(profile.known_languages) ? [...profile.known_languages] : [],
    });
    try {
      void enforceConference(callerCallId);
    } catch {
      /* enforcement never breaks the join */
    }
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

  /** Drop one call's cached toggle (event-driven invalidation; TTL is backstop). */
  function invalidateToggle(callId: string): void {
    if (callId) toggleCache.delete(callId);
  }
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
      // Gated rendition: operator speech renders into the caller channel ONLY
      // when translation is ON for the caller call AND the caller tongue is
      // unknown to the operator. Otherwise the caller hears the operator's
      // original conference audio and the engine stays out of it.
      if (peer) {
        const prof = resolveProfile(peer.callId, callId);
        const tongue = langByCall.get(peer.callId);
        const render =
          !!prof?.operator_id &&
          !isKnownTongue(tongue, prof.known_languages ?? []) &&
          (await isTranslationEnabled(peer.callId));
        if (render) {
          await translateAndSpeak(callerChannel, text, replyVoice(callerLang).code, effLang);
        }
      }
      // Conferencing enforcement for the caller call (desired = !toggle,
      // OR known-tongue => conference). After the rendition so in-flight
      // utterances finish under the old state; warn-never-break.
      try {
        if (peer) await enforceConference(peer.callId, langByCall.get(peer.callId), callId);
      } catch (err) {
        deps.log("warn", "conference enforcement failed", { callId, err: String(err) });
      }
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
      // Same bridge, other ear: operator hears the caller translated — ONLY
      // when translation is ON and the tongue is unknown. In every other case
      // (OFF, known tongue, no profile) the operator hears the original
      // conference audio and nothing is rendered. Nudge once on mismatch.
      const peer = ari.bridgePeer(callId);
      if (peer && peer.role === "operator") {
        const prof = resolveProfile(callId, peer.callId);
        const tongue0 = effLang ?? prior ?? "Marathi";
        const toggleOn = prof?.operator_id ? await isTranslationEnabled(callId) : false;
        if (prof?.operator_id && !isKnownTongue(tongue0, prof.known_languages ?? []) && !toggleOn && !nudged.has(callId)) {
          nudged.add(callId);
          try {
            deps.publish?.("translation.suggested", callId, {
              call_id: callId,
              caller_language: tongue0,
              operator_id: prof.operator_id,
            });
          } catch {
            /* publish must never break the loop */
          }
        }
      }
    } catch (err) {
      deps.log("warn", "final-loop failed", { callId, err: String(err) });
    }
    // Caller->operator rendition (translation toggle): AFTER the existing
    // logic so emergency replies never depend on it.
    // Structured without early returns so the conferencing enforcement below
    // always runs (known-tongue must still conference; task: desired = !enabled,
    // OR known => conference).
    try {
      const peer = ari.bridgePeer(callId);
      if (peer && peer.role === "operator") {
        const opChannel = ari.channelForCall(peer.callId);
        const profile = resolveProfile(callId, peer.callId);
        if (opChannel && profile?.operator_id) {
          const tongue = effLang ?? prior ?? "Marathi";
          if (!isKnownTongue(tongue, profile.known_languages ?? [])) {
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
          }
        }
      }
    } catch (err) {
      deps.log("warn", "translation rendition failed", { callId, err: String(err) });
    }
    // Conferencing enforcement for this caller call (desired = !toggle, OR
    // known-tongue => conference). After the toggle read above so the 2s TTL
    // cache is warm; mid-call flips move the leg within ~2s + utterance time.
    // In-flight utterances already finished above (no preemption).
    // Warn-never-break: never throws, never breaks the call loop.
    try {
      const peer = ari.bridgePeer(callId);
      const tongue = effLang ?? prior ?? langByCall.get(callId);
      await enforceConference(callId, tongue, peer?.callId);
    } catch (err) {
      deps.log("warn", "conference enforcement failed", { callId, err: String(err) });
    }
  }

  /** Toggle-driven conferencing enforcement for a caller call.
   *  Desired membership = !translationToggle OR known-tongue => conference;
   *  only toggle ON + unknown tongue => separated. (Task shorthand
   *  "desired = !enabled" is the unknown-tongue case; the known-tongue OR
   *  satisfies the LOCKED direct-conference rule.)
   *  Warn-never-break: missing ari/method, toggle fetch failure (defaults
   *  false => conference), and add/remove failures all log and return. */
  async function enforceConference(
    callerCallId: string,
    tongueHint?: string,
    operatorCallIdHint?: string,
  ): Promise<void> {
    try {
      const ariCtl = deps.ari() as unknown as {
        setOperatorConferenced?: (id: string, conferenced: boolean) => Promise<void>;
      } | null;
      if (!ariCtl || typeof ariCtl.setOperatorConferenced !== "function") return;
      if (!callerCallId) return;
      const profile = resolveProfile(callerCallId, operatorCallIdHint);
      const tongue = tongueHint ?? langByCall.get(callerCallId);
      const known = profile?.operator_id ? isKnownTongue(tongue, profile.known_languages ?? []) : false;
      let enabled = false;
      try {
        enabled = await isTranslationEnabled(callerCallId);
      } catch (err) {
        deps.log("warn", "conference toggle read failed", { callId: callerCallId, err: String(err) });
        enabled = false;
      }
      const desired = !enabled || known;
      try {
        await ariCtl.setOperatorConferenced(callerCallId, desired);
      } catch (err) {
        deps.log("warn", "conference enforcement failed", { callId: callerCallId, desired, err: String(err) });
      }
    } catch (err) {
      try {
        deps.log("warn", "conference enforcement failed", { callId: callerCallId, err: String(err) });
      } catch {
        /* log must never throw */
      }
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
    invalidateToggle,
    enforceConference,
    toggleCache,
    profileByCall,
    nudged,
  };
}

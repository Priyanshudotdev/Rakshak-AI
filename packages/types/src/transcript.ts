export type Speaker = "caller" | "operator" | "unknown";

export interface TranscriptSegment {
  callId: string;
  speaker: Speaker;
  /** Original caller wording — never overwritten by translation. */
  originalText: string;
  translatedText?: string;
  language?: string;
  languageCode?: string;
  confidence?: number;
  isPartial: boolean;
  startTime?: string;
  endTime?: string;
}

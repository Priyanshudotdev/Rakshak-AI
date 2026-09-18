export const LANGUAGE_NAMES: Record<string, string> = {
  "as-IN": "Assamese", "bn-IN": "Bengali", "brx-IN": "Bodo", "doi-IN": "Dogri",
  "en-IN": "English", en: "English", "gu-IN": "Gujarati", "hi-IN": "Hindi",
  "kn-IN": "Kannada", "ks-IN": "Kashmiri", "kok-IN": "Konkani", "mai-IN": "Maithili",
  "ml-IN": "Malayalam", "mni-IN": "Manipuri", "mr-IN": "Marathi", "ne-IN": "Nepali",
  "od-IN": "Odia", "pa-IN": "Punjabi", "sa-IN": "Sanskrit", "sat-IN": "Santali",
  "sd-IN": "Sindhi", "ta-IN": "Tamil", "te-IN": "Telugu", "ur-IN": "Urdu",
  unknown: "Unknown",
};

export function languageName(code?: string | null): string {
  if (!code) return "Unknown";
  return LANGUAGE_NAMES[code] ?? code;
}

export function isEnglish(code?: string | null): boolean {
  if (!code) return false;
  return ["en", "en-in", "en-us", "en-gb"].includes(code.toLowerCase());
}

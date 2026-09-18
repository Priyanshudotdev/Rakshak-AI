// Keyword-rules fallback — mirrors legacy/pipeline.py fallback_extract verbatim intent.
export function fallbackExtract(originalText: string, englishText: string): Record<string, any> {
  const blob = `${originalText || ""}\n${englishText || ""}`.toLowerCase();
  const english = (englishText || originalText || "").toLowerCase();

  const areas: Array<[string, string]> = [
    ["manish nagar", "Manish Nagar"], ["मानीश नगर", "Manish Nagar"],
    ["raj nagar", "Raj Nagar"], ["राज नगर", "Raj Nagar"],
    ["sitabuldi", "Sitabuldi"], ["सिताबुल्डी", "Sitabuldi"],
    ["dharampeth", "Dharampeth"], ["धर्मपेठ", "Dharampeth"],
    ["ramdaspeth", "Ramdaspeth"], ["sadar", "Sadar"], ["सदर", "Sadar"],
  ];
  let area = "Not identified";
  for (const [needle, label] of areas) {
    if (blob.includes(needle.toLowerCase())) { area = label; break; }
  }

  let weaponType: string | null = null;
  if (["चाकू", "knife", "chakoo"].some((t) => blob.includes(t))) weaponType = "knife";
  else if (["gun", "pistol", "पिस्तौल", "बंदूक"].some((t) => blob.includes(t))) weaponType = "gun";
  else if (["रॉड", "rod"].some((t) => blob.includes(t))) weaponType = "rod";

  let primary = "Unknown", secondary = "";
  if (["fire", "smoke", "आग", "धुआं"].some((t) => blob.includes(t))) { primary = "Fire"; secondary = "Building fire"; }
  else if (["accident", "दुर्घटना", "injured", "जख्मी"].some((t) => blob.includes(t))) { primary = "Traffic Accident"; secondary = "Multiple injured"; }
  else if (["chest", "ambulance", "एम्बुलन्स", "एम्बुलेंस", "breath", "छाती"].some((t) => blob.includes(t))) { primary = "Medical Emergency"; secondary = "Chest pain / breathing"; }
  else if (["theft", "चोरी", "robbery", "कैश", "dukan", "दुकान"].some((t) => blob.includes(t))) {
    primary = "Theft";
    secondary = ["अभी", "now", "यहीं"].some((t) => blob.includes(t)) ? "In progress" : "Past incident";
  } else if (["husband", "पती", "domestic", "मारायला", "मार"].some((t) => blob.includes(t))) {
    primary = "Domestic Violence"; secondary = weaponType ? "Assault with weapon" : "Assault";
  }

  let immediate = Boolean(weaponType || english.includes("fire") || english.includes("ambulance") || ["अभी यहीं", "मारायला", "जख्मी"].some((t) => blob.includes(t)));
  if (["कल रात", "yesterday", "रिपोर्ट दर्ज"].some((t) => blob.includes(t))) immediate = false;

  const femaleTokens = ["माझा पती", "माझा नवरा", "my husband", "मेरा पति", "मेरा पती", "तिच्या", "woman", "girl", "lady", "स्त्री", "महिला", "आई", "mother", "daughter", "बहीण", "sister"];
  const maleTokens = ["माझी बायको", "माझी पत्नी", "my wife", "मेरी पत्नी", "father", "बाबा", "बाबांना", "brother", "भाऊ", "man", "boy", "पुरुष", "दुकानदार"];
  let callerGender = "Unknown";
  if (femaleTokens.some((t) => blob.includes(t))) callerGender = "Female";
  else if (maleTokens.some((t) => blob.includes(t))) callerGender = "Male";

  return {
    location: { area, landmark: "", address: "", confidence: area !== "Not identified" ? 0.7 : 0.2, notes: "keyword fallback" },
    incident_type: { primary, secondary, confidence: 0.7, keywords_found: [] },
    people_involved: {
      victim: { gender: callerGender, relationship_to_suspect: "", status: "unknown", description: "" },
      suspect: { gender: callerGender === "Female" && blob.includes("husband") ? "Male" : "Unknown", relationship_to_victim: "", status: "unknown", description: "" },
      witnesses: "", total_people: "",
    },
    weapon_mentioned: { is_weapon_present: Boolean(weaponType), weapon_type: weaponType, confidence: weaponType ? 0.9 : 0.6, context: weaponType ? "keyword match" : "none mentioned" },
    immediate_danger: { is_immediate_danger: immediate, risk_level: immediate ? 9 : 3, danger_indicators: immediate ? [primary] : [], confidence: 0.7 },
    distress_indicators: { caller_state: immediate ? "distressed" : "calm", background_sounds: [], confidence: 0.6 },
    caller_gender: callerGender,
    summary: (englishText || originalText || "No transcript available").slice(0, 280),
  };
}

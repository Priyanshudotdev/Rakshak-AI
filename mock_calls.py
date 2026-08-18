MOCK_EMERGENCY_CALLS = [
    {
        "call_id": "CALL_001",
        "original_language": "Marathi",
        "scenario": "Domestic violence with weapon",
        "area_hint": "Manish Nagar",
        "transcript": (
            "साहेब! मुझे तो मदत करा! माझा पती मला मारायला येतोय! "
            "तिच्या हाती चाकू आहे! मी मानीश नगरमध्ये आहे, "
            "रोज मार्केट जवळ! कृपया पोलीस पाठवा!"
        ),
    },
    {
        "call_id": "CALL_002",
        "original_language": "Hindi",
        "scenario": "Road accident, multiple injured",
        "area_hint": "Raj Nagar",
        "transcript": (
            "भैया... मेरे घर के सामने बहुत तेज सड़क दुर्घटना हुई है। "
            "कई लोग जख्मी हैं। लाल बिल्डिंग के पास, राज नगर में। "
            "कृपया एम्बुलेंस भेजो जल्दी!"
        ),
    },
    {
        "call_id": "CALL_003",
        "original_language": "Marathi",
        "scenario": "Medical emergency, chest pain",
        "area_hint": "Sitabuldi",
        "transcript": (
            "मदत करा साहेब, माझ्या बाबांना छातीत खूप दुखत आहे, "
            "श्वास घेता येत नाही. आम्ही सिताबुल्डी मार्केट जवळ "
            "तिसऱ्या मजल्यावर आहोत. एम्बुलन्स पाठवा, प्लीज."
        ),
    },
    {
        "call_id": "CALL_004",
        "original_language": "Hindi",
        "scenario": "Theft in progress",
        "area_hint": "Dharampeth",
        "transcript": (
            "पुलिस? अभी अभी दो आदमी मोटरसाइकिल पर आए और "
            "मेरी दुकान से कैश निकाल रहे हैं। एक के हाथ में लोहे की रॉड है। "
            "धर्मपेठ, वेस्ट हाईकोर्ट रोड, सोनार दुकान के बगल में। वो अभी यहीं हैं!"
        ),
    },
    {
        "call_id": "CALL_005",
        "original_language": "English",
        "scenario": "Fire in apartment block",
        "area_hint": "Ramdaspeth",
        "transcript": (
            "Hello police, there is a fire on the second floor of my building. "
            "Smoke is filling the stairwell. Address is plot 14, Ramdaspeth, "
            "near the old water tank. Some families are still inside."
        ),
    },
    {
        "call_id": "CALL_006",
        "original_language": "Hindi",
        "scenario": "Past incident, no ongoing threat",
        "area_hint": "Sadar",
        "transcript": (
            "नमस्ते, मैं सदर से बोल रहा हूँ। कल रात मेरी साइकिल चोरी हो गई थी "
            "स्टेशन के पास पार्किंग से। कोई चोट नहीं है, और अभी कोई खतरा भी नहीं है। "
            "सिर्फ रिपोर्ट दर्ज करानी है।"
        ),
    },
]


def get_call(call_id):
    return next((c for c in MOCK_EMERGENCY_CALLS if c["call_id"] == call_id), None)

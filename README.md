# 🛡️ Rakshak AI built by _Team Falcons_

**AI-powered emergency call copilot for faster and smarter emergency response.**

Rakshak AI processes emergency calls in real time to:

- 🎙️ Transcribe speech
- 🌐 Detect and translate languages
- 🧠 Extract critical information
- 🚨 Detect urgency and priority
- 📍 Identify location and incident details
- 📋 Generate concise incident summaries

### Tech Stack

Python · Flask · Sarvam AI · Gemini · JavaScript

### Run Locally

1. Copy `.env.example` to `.env` and fill in your API keys:

   ```
   SARVAM_API_KEY=your_sarvam_key      # required
   GEMINI_API_KEY=your_gemini_key      # optional fallback for extraction
   ```

2. Install dependencies and start the server:

   ```bash
   pip install -r requirements.txt
   python app.py
   ```

The app serves on `http://localhost:5000`. Set `FLASK_DEBUG=1` in `.env` to enable auto-reload during development.

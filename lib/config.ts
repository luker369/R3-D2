/**
 * Index of tunable constants scattered across the codebase. This file does NOT
 * move the source of truth — each constant still lives in its original module.
 * This is a discoverability aid: one place to grep for "where do I change X?"
 *
 * If you find yourself adding a new tuning knob, leave it where it's used and
 * add a line here so future-you can find it.
 */

// ─── Feature flags / kill switches ──────────────────────────────────────────
// See lib/feature-flags.ts
//   ENABLE_WEB_SEARCH           — OpenAI web_search_preview tool
//   ENABLE_MEMORY_EXTRACTION    — post-turn memory extraction
//   ENABLE_FGS                  — Android foreground service
//   R2_CHIRP_ON_EVERY_HOME_FOCUS — R2 chirp on focus vs. cold start

// ─── Prompts / model selection ──────────────────────────────────────────────
// services/openai.ts
//   SYSTEM_PROMPT               — assistant persona (line ~139)
//   buildSystemContent          — merges persona + memory + settings
//   streamChatResponse          — model: 'gpt-5.4-mini' (line ~394)
//   getChatResponse             — default model: 'gpt-5.4'
//   SEARCH_TRIGGERS             — regex list deciding when web search is attached
//   TTS_VOICES                  — allowed TTS voice IDs
// services/memory.ts
//   compressMemories            — model: 'gpt-5.4' (line ~128)
//   extractAndSaveMemory        — model: 'gpt-5.4-mini' (line ~207)

// ─── Voice loop tuning ──────────────────────────────────────────────────────
// hooks/use-voice-assistant.ts (lines ~141-146)
//   SILENCE_DURATION_MS         — 900ms VAD silence → stop recording
//   SPEECH_CONFIRM_SAMPLES      — sustained frames to arm the VAD
//   MIN_SPEECH_DURATION_MS      — minimum utterance length
//   POST_RESTART_GRACE_MS       — mic-restart grace to block TTS bleed
//   SPEECH_MARGIN_DB            — dB above ambient floor
//   AMBIENT_ALPHA               — EMA smoothing constant
//   MIN_TTS_WORDS_FIRST / _REST — sentence-word thresholds for TTS
//   MAX_TTS_INFLIGHT            — concurrent TTS synthesis cap

// ─── Memory thresholds ──────────────────────────────────────────────────────
// services/memory.ts
//   COMPRESS_THRESHOLD          — row count that triggers compression (line ~69)
//   SAVED_SESSION_MAX           — dedup set cap before clearing

// ─── Timeouts ───────────────────────────────────────────────────────────────
// services/openai.ts
//   IDLE_TOKEN_MS               — chat stream idle watchdog (15s)
//   xhr.timeout                 — chat stream overall (60s)
//   fetchWithTimeout             — STT/TTS wrappers

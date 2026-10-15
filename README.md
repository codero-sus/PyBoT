# PyBoT

A personal assistant with a responsive web UI and a Python backend. Its deterministic helpers run with the Python standard library; open-ended chat can use a separate local Cortex LLMHoster. No cloud inference account is required.

## Run

```bash
python app.py
```

Then open [http://localhost:8000](http://localhost:8000). To use a different port, set `PORT=9000 python app.py` or pass `--port 9000`. The server binds to `0.0.0.0` by default so it also works in a hosted preview.

## What it can do

- Use Cortex LLMHoster for open-ended chat when configured; choose any hosted text model from the sidebar. Local greetings, time/date answers, safe calculations, and custom commands continue to work without Cortex.
- Calculate common arithmetic expressions directly in chat, with a safe parser instead of `eval`.
- Use built-in English, Spanish, French, German, and Japanese interface and reply packs, or add custom translations.
- Choose from 170+ language and regional presets when building command packages; enter trigger phrases and replies in the language you select. Presets are listed in `static/language-catalog.json`, and custom language codes are also accepted.
- Add custom UI/reply translations from the **Add language** dialog. Packs are saved in the current browser; a downloadable JSON template shows all supported translation keys.
- Build language-scoped command packages from reusable trigger phrases and text replies, then install them or export/import portable `.pybot.json` files.
- Custom commands are exact phrase-to-text rules (case and punctuation are ignored). They never execute Python or shell code; `{time}` and `{date}` can be used in replies.
- Use browser speech recognition for dictation and text-to-speech for assistant replies where supported.
- Search recent conversations by title or message text, export the active conversation as Markdown, and keep sessions in browser storage.
- Choose a Cortex text-generation model from the sidebar; the selected model is remembered in the current browser.

## Build command packages

Open **Command packages** in the sidebar, name the package, choose a built-in or custom language, then add commands. Give each command one or more trigger phrases (one per line) and a text reply. **Build & install** makes the package available in that browser; **Download JSON** exports it, while **Import JSON** installs a package file elsewhere. Replies may use `{time}` and `{date}` placeholders. Matching is exact apart from capitalization and punctuation.

These are intentionally declarative, text-only commands: package files are never executed as Python or shell code. The exported JSON format is versioned (`format: "pybot-command-package"`, `version: 1`) and contains the package language plus each command's `name`, `triggers`, and `reply`.

## Cortex LLMHoster

PyBoT can send open-ended prompts to [Cortex LLMHoster](https://github.com/codero-sus/Cortex_LLMHoster/tree/arena%2Fb3072048-cortex-llmhoster) through its OpenAI-compatible local API. PyBoT handles greetings, time/date, calculations, and installed command packages first; only unmatched questions are sent to Cortex. Up to 12 recent user/assistant messages are included for context. The Cortex source and model runtime are not bundled or modified by PyBoT.

Start and configure Cortex separately, following its installation guide. By default, PyBoT looks for Cortex at `http://127.0.0.1:8624/v1`:

```bash
export PYBOT_CORTEX_BASE_URL="http://127.0.0.1:8624/v1"
export PYBOT_CORTEX_MODEL="qwen-local"  # optional; otherwise PyBoT selects a text-generation model
export CORTEX_API_KEY="your-local-bearer-secret"  # only if configured in Cortex
python app.py
```

`CORTEX_API_KEY` is Cortex's optional local bearer secret, not a cloud-provider credential. Set the same value in the environments running Cortex and PyBoT. Set `PYBOT_CORTEX_ENABLED=false` to disable model calls and use only the built-in assistant. If Cortex is unreachable or not ready, PyBoT falls back to its local reply and shows a warning; the sidebar reports Cortex readiness. Keep Cortex on a trusted private network. In a hosted preview, `127.0.0.1` refers to the PyBoT server's sandbox, not your own computer; use a private, reachable endpoint only if the server must connect to a separately hosted Cortex instance.

## Tests

```bash
python -m unittest discover -s tests -v
```

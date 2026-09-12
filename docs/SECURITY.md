# Security boundaries

The model receives only the function tools in `src/ai/tools.ts`. Arguments are validated again in `ToolExecutor`. The controller provides no shell, JavaScript evaluation, filesystem, arbitrary HTTP, credential, session, raw-packet, or plugin-install tool.

Server profile commands are explicit operator-controlled mappings. The model cannot invent a raw command through `server_action`; only named entries are accepted. The `say` tool rejects slash-prefixed text, so commands can run only through a configured profile action.

Secrets belong in `.env` or a VPS secret manager. `.env`, `data/`, runtime logs, and local profile files are ignored by Git. Authentication tokens are managed by the supported Microsoft device flow and stored below `data/auth`. Log redaction covers common key, token, session, and password field names.

Do not add bypass, evasion, exploit, stealth, alternate-account rotation, or CAPTCHA-solving behavior. A kick or rejection is an error to surface, not a challenge to defeat.

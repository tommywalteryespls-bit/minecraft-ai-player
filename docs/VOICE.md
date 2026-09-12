# Voice implementation notes

Simple Voice Chat transport is loaded only when both the selected profile and `VOICE_ENABLED` opt in. Its optional Mineflayer plugin supplies decoded 48 kHz mono signed 16-bit PCM plus sender UUID/distance. Frames are grouped by sender until 850 ms of silence.

OpenAI Realtime transcription uses the current GA transcription-session WebSocket helper and receives downsampled 24 kHz PCM. If the session or transcript fails, the same utterance is wrapped in a WAV container and sent to the Audio transcription endpoint. The resulting text enters exactly the same event, memory, planning, and tool path as Minecraft text chat.

The final grounded answer is generated as speech with the OpenAI Audio API. The Mineflayer voice transport accepts the temporary MP3 path and emits the audio from the bot’s in-game position. Temporary incoming WAV files are deleted immediately; outgoing MP3 files are deleted after the plugin has had time to consume them.

The optional transport depends on FFmpeg, native Opus, UDP reachability, server settings, and compatible Simple Voice Chat versions. These are environmental requirements, not bypass targets. A transport failure disables voice for that path and may fall back to text.

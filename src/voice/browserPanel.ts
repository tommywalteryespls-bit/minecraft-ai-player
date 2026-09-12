// Served by the loopback voice server; no external assets, tracking, or client-side API credentials.
export const browserHtml = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Private microphone and spoken replies for your Minecraft companion.">
<title>Minecraft companion · Voice</title>
<style>
:root{color-scheme:dark;font-family:Segoe UI,system-ui,sans-serif;color:#eef5fc;background:#0d141c;font-size:16px;--line:#304155;--muted:#adc0d1;--accent:#68dfed}
*{box-sizing:border-box}body{margin:0}main{max-width:980px;margin:0 auto;padding:40px 24px}header{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:28px}
h1{font-size:2rem;margin:6px 0;font-weight:650;letter-spacing:-.04em}h2{font-size:1.1rem;margin:0 0 18px}p{line-height:1.55}small,.sub{font-size:.9rem;color:var(--muted)}.eyebrow{color:var(--accent);font-size:.9rem;letter-spacing:.1em;text-transform:uppercase}
.badge{border:1px solid var(--line);padding:9px 14px;border-radius:20px;white-space:nowrap;font-size:.9rem}.grid{display:grid;grid-template-columns:1.15fr 1fr;gap:20px}.card{border:1px solid var(--line);border-radius:16px;background:#14202c;padding:24px}
.state{font-size:1.45rem;margin:16px 0 10px;font-weight:600;min-height:2rem}.meter{width:100%;height:12px;appearance:none;border:0;border-radius:8px;overflow:hidden;background:#0d141c}.meter::-webkit-progress-bar{background:#0d141c}.meter::-webkit-progress-value{background:var(--accent)}.meter::-moz-progress-bar{background:var(--accent)}
.controls{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}button{font:inherit;font-weight:600;border:1px solid var(--line);background:#23364a;color:#eef5fc;border-radius:9px;padding:12px 16px;cursor:pointer;min-height:46px}button.primary{background:var(--accent);color:#0b2228;border-color:var(--accent)}button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,a:focus-visible{outline:3px solid #fff;outline-offset:3px}
.error{color:#ffd0c6;background:#3c2227;border:1px solid #87544d;padding:12px;border-radius:8px;margin-top:18px;white-space:pre-wrap}.details{display:grid;grid-template-columns:90px minmax(0,1fr);gap:12px;font-size:.95rem}.details dt{color:var(--muted)}.details dd{margin:0;overflow-wrap:anywhere}.history{margin-top:20px}.messages{max-height:350px;overflow:auto}.message{padding:14px 0;border-top:1px solid var(--line)}.message p{white-space:pre-wrap;margin:7px 0;overflow-wrap:anywhere}.message strong{color:var(--accent);font-size:.9rem}.empty{color:var(--muted)}audio{width:100%;margin-top:15px}footer{color:var(--muted);font-size:.9rem;margin-top:20px;line-height:1.6}code{font-family:Consolas,monospace;color:#e3faff}
@media(max-width:700px){main{padding:24px 16px}.grid{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column;gap:10px}.card{padding:20px}}
</style><script src="/app.js" defer></script></head><body><main>
<header><div><div class="eyebrow">Minecraft companion</div><h1 id="title">Voice panel</h1><div class="sub">Local microphone · Browser replies · No voice mod</div></div><span class="badge" id="connection">Checking connection…</span></header>
<div class="grid"><section class="card" aria-labelledby="mic-heading"><h2 id="mic-heading">Talk while you play</h2>
<div class="state" id="state" role="status" aria-live="polite">Microphone off</div><progress id="meter" class="meter" max="1" value="0" aria-label="Microphone level"></progress>
<p class="sub" id="listeningHelp">Start hands-free, then switch back to Minecraft. Pause after each command and wait for the reply. Keep this tab open and use headphones.</p>
<div class="controls"><button class="primary" id="handsfree" disabled>Start hands-free</button><button id="manual" disabled>Record one message</button><button id="stop" disabled>Stop listening</button></div>
<p class="sub" id="modeHelp">Manual recording uses this tab’s button, not a global Minecraft hotkey.</p>
<div id="error" class="error" role="alert" hidden></div><audio id="audio" controls hidden aria-label="AI spoken reply"></audio></section>
<section class="card" aria-labelledby="session-heading"><h2 id="session-heading">Your session</h2><dl class="details"><dt>Player</dt><dd id="player">—</dd><dt>Server</dt><dd id="server">—</dd><dt>Planner</dt><dd id="planner">—</dd><dt>Transcription</dt><dd id="transcriber">—</dd><dt>Speech</dt><dd id="speech">—</dd></dl>
<p class="sub" id="examples">Try: “Astra, follow me,” “stop following,” or “what are you doing?” Following requires your player to be loaded near the bot.</p></section></div>
<section class="card history" aria-labelledby="history-heading"><h2 id="history-heading">Conversation</h2><div class="messages" id="messages" role="log" aria-live="polite"><p class="empty" id="empty">Your transcript and the bot’s reply will appear here.</p></div></section>
<footer>Replies use an AI-generated voice. Microphone audio is sent to OpenAI only for submitted speech turns; transcription, reasoning, and speech use API credits. Transcripts may be saved in the bot’s existing memory. Other Minecraft players cannot hear this panel. Stopping listening does not undo game actions already started.</footer>
</main></body></html>`;

export const browserScript = String.raw`
'use strict';
const $ = (id) => document.getElementById(id);
let token = '', ready = false, mode = 'off', busy = false, starting = false;
let controlEnabled = true, supportsInterrupt = false;
let context = null, stream = null, processor = null, source = null, sink = null;
let request = null, interruption = null, pendingInterrupt = null, generation = 0, audioUrl = null, pollBusy = false, turn = 0, captureInterruptOnly = false;
const audio = $('audio');
function state(text) { $('state').textContent = text; }
function error(text) { $('error').textContent = text; $('error').hidden = !text; }
function controls() {
  $('handsfree').disabled = !ready || mode !== 'off' || busy || starting;
  $('manual').disabled = !ready || !controlEnabled || busy || starting || mode === 'auto';
  $('manual').textContent = mode === 'manual' ? 'Send message' : 'Record one message';
  $('stop').disabled = !supportsInterrupt && mode === 'off' && !busy && !starting;
  $('stop').textContent = supportsInterrupt ? 'Stop actions & listening' : 'Stop listening';
}
function message(who, text) {
  if (!text) return;
  $('empty')?.remove();
  const item = document.createElement('div'); item.className = 'message';
  const name = document.createElement('strong'); name.textContent = who;
  const body = document.createElement('p'); body.textContent = text;
  item.append(name, body); $('messages').append(item);
  while ($('messages').children.length > 50) $('messages').firstElementChild.remove();
  $('messages').scrollTop = $('messages').scrollHeight;
}
async function refresh(initial = false) {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const response = await fetch(initial || !token ? '/api/session' : '/api/status', { headers: { 'X-Voice-Token': token } });
    if (!response.ok) throw new Error('Panel connection lost. Reload this page after restarting the bot.');
    const data = await response.json(); if (data.token) token = data.token;
    const wasEnabled = controlEnabled;
    const couldInterrupt = supportsInterrupt;
    controlEnabled = data.controlEnabled !== false;
    supportsInterrupt = data.supportsInterrupt === true;
    ready = data.connected && data.enabled && data.ownerValid;
    if (couldInterrupt !== supportsInterrupt && busy) resumeCapture();
    $('title').textContent = (data.aiName || 'Companion') + ' · Voice';
    $('connection').textContent = data.connected ? 'Minecraft connected' : 'Minecraft disconnected';
    $('player').textContent = data.owner || 'Set AI_OWNER in .env';
    $('server').textContent = data.serverId || 'Waiting for the bot';
    $('planner').textContent = data.plannerModel || '—';
    $('transcriber').textContent = data.transcribeModel || '—';
    $('speech').textContent = [data.ttsModel, data.voice].filter(Boolean).join(' · ');
    if (data.controller === 'fabric') {
      $('examples').textContent = 'You control your own player. Try “walk forward for two seconds,” “turn right,” “jump,” or “mine the block I am looking at.” F8 enables control; F9 is emergency stop.';
      $('modeHelp').textContent = 'Start hands-free, return to Minecraft, close menus, and press F8. Wait a few seconds for the microphone to activate. Menus or manual movement disable control.';
    }
    $('listeningHelp').textContent = 'Start hands-free, then switch back to Minecraft. Pause after each command and wait for the reply. Keep this tab open and use headphones.';
    if (supportsInterrupt) {
      $('listeningHelp').textContent = 'Keep this tab open and use headphones: your microphone stays active during tasks and spoken replies so you can say “stop”. Speech heard while busy is transcribed only to detect a stop request; it cannot start another task. These transcriptions use API credits. Speaker echo can cause accidental stops.';
      if (data.unlimitedTurns) $('modeHelp').textContent = 'Continuous task mode: tasks can keep using API credits until complete or stopped. Say “stop”, use Stop actions & listening, or press F9 in Minecraft. Use headphones for spoken interruption.';
    }
    if (!ready) {
      if (mode !== 'off' || starting || busy) await stop();
      error(data.availabilityReason || (!data.ownerValid ? 'Set AI_OWNER to your Minecraft username (not an email), then restart the bot.' : !data.enabled ? 'Voice is disabled or OPENAI_API_KEY is not configured.' : 'Waiting for the bot to connect to Minecraft.'));
    } else if (!controlEnabled) {
      processor?.port.postMessage({ type: 'pause' });
      if (mode !== 'off' && !busy) state('Mic ready · Press F8 in Minecraft');
      error(data.availabilityReason || 'Press F8 in Minecraft to enable player control. F9 stops it.');
    } else {
      if (initial || !wasEnabled) error('');
      if (!wasEnabled && mode === 'auto' && !busy) { processor?.port.postMessage({ type: 'mode', mode: 'auto' }); state('Listening…'); }
    }
  } catch (e) {
    ready = false; if (mode !== 'off' || starting || busy) await stop(); error(e.message);
    $('connection').textContent = 'Panel disconnected';
  } finally { pollBusy = false; controls(); }
}
async function stop(cancelActions = true) {
  generation++; turn++; mode = 'off'; starting = false; busy = false; captureInterruptOnly = false; pendingInterrupt = null;
  request?.abort(); request = null; interruption?.abort(); interruption = null; audio.pause(); audio.currentTime = 0;
  // Dispatch before awaiting microphone cleanup, so stopping never waits for the audio device.
  const stopping = cancelActions && supportsInterrupt && token ? fetch('/api/stop', { method: 'POST', headers: { 'X-Voice-Token': token }, keepalive: true })
    .then((response) => { if (!response.ok) throw new Error('Could not confirm Minecraft stopped. Press F9 in Minecraft.'); }) : Promise.resolve();
  const stopResult = stopping.catch((e) => e);
  processor?.port.postMessage({ type: 'mode', mode: 'off' });
  stream?.getTracks().forEach((track) => track.stop()); stream = null;
  source?.disconnect(); processor?.disconnect(); sink?.disconnect(); source = processor = sink = null;
  const previous = context; context = null;
  if (previous && previous.state !== 'closed') await previous.close().catch(() => {});
  $('meter').value = 0; state('Microphone off'); controls();
  const failure = await stopResult;
  if (failure) error(failure.message || 'Could not confirm Minecraft stopped. Press F9 in Minecraft.');
}
function resumeCapture() {
  if (!processor || mode === 'off' || !ready || !controlEnabled) return;
  if (busy && !supportsInterrupt) { processor.port.postMessage({ type: 'pause' }); return; }
  processor.port.postMessage({ type: 'mode', mode: busy ? 'auto' : mode });
}
function stoppedReply() {
  // Invalidate pending speech/playback callbacks without discarding the user's microphone setup.
  turn++; pendingInterrupt = null; request?.abort(); request = null; audio.pause(); audio.currentTime = 0; busy = false;
  if (mode === 'manual') { void stop(false); return; }
  state(controlEnabled ? 'Stopped · Listening…' : 'Stopped · Press F8 in Minecraft');
  resumeCapture(); controls();
}
async function start(nextMode) {
  if (!ready || starting || busy || mode !== 'off') return;
  audio.pause();
  const current = ++generation; pendingInterrupt = null; starting = true; error(''); controls(); state('Requesting microphone…');
  let acquired = null, created = null;
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('Use current Chrome or Edge on the local panel URL.');
    created = new AudioContext({ sampleRate: 48000 });
    await created.resume();
    acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (current !== generation) { acquired.getTracks().forEach((track) => track.stop()); await created.close(); return; }
    if (created.sampleRate !== 48000) throw new Error('This browser cannot capture at 48 kHz. Try Chrome or Edge.');
    await created.audioWorklet.addModule('/capture.js');
    if (current !== generation) { acquired.getTracks().forEach((track) => track.stop()); await created.close(); return; }
    context = created; stream = acquired;
    processor = new AudioWorkletNode(context, 'voice-capture');
    source = context.createMediaStreamSource(stream); sink = context.createGain(); sink.gain.value = 0;
    source.connect(processor); processor.connect(sink); sink.connect(context.destination);
    processor.port.onmessage = (event) => {
      if (current !== generation) return;
      if (event.data.type === 'level') $('meter').value = Math.min(1, event.data.level * 8);
      if (event.data.type === 'speech') {
        captureInterruptOnly = busy || Boolean(request) || Boolean(interruption) || Boolean(pendingInterrupt);
        state(captureInterruptOnly && supportsInterrupt ? 'Listening for “stop”…' : 'Hearing you…');
      }
      if (event.data.type === 'audio') {
        const interruptOnly = captureInterruptOnly; captureInterruptOnly = false;
        void submit(event.data.audio, current, interruptOnly);
      }
      if (event.data.type === 'empty') { state(busy ? 'Working · Say “stop” to interrupt' : 'Listening…'); }
    };
    stream.getAudioTracks()[0].onended = () => { if (current === generation) void stop().then(() => error('Microphone disconnected. Start listening again.')); };
    mode = nextMode; starting = false;
    processor.port.postMessage({ type: 'mode', mode: controlEnabled ? mode : 'off' });
    state(!controlEnabled ? 'Mic ready · Press F8 in Minecraft' : mode === 'auto' ? 'Listening…' : 'Recording… click Send message'); controls();
  } catch (e) {
    acquired?.getTracks().forEach((track) => track.stop());
    if (created && created.state !== 'closed') await created.close().catch(() => {});
    if (current === generation) { await stop(); error(e.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the browser address bar, then try again.' : e.message); }
  }
}
async function submit(pcm, current, interruptOnly = false) {
  if (current !== generation || !controlEnabled) return;
  if (interruptOnly || busy || request || interruption || pendingInterrupt) {
    if (supportsInterrupt) await submitInterrupt(pcm, current);
    return;
  }
  const currentTurn = ++turn;
  busy = true; resumeCapture();
  state(supportsInterrupt ? 'Working · Say “stop” to interrupt' : 'Thinking and preparing reply…'); controls();
  const controller = new AbortController(); request = controller;
  try {
    const response = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Voice-Token': token }, body: pcm, signal: controller.signal });
    const result = await response.json();
    if (current !== generation || currentTurn !== turn) return;
    if (result.stopped) { stoppedReply(); return; }
    message($('player').textContent, result.transcript); message($('title').textContent.replace(' · Voice', ''), result.reply);
    if (!response.ok || !result.success) throw new Error((result.stage ? result.stage + ': ' : '') + (result.reason || 'Voice request failed') + (result.reply ? ' The reply is shown above; game actions may already have completed.' : ''));
    if (!result.audioBase64) throw new Error('No speech audio was returned.');
    const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    const replyAudioUrl = audioUrl;
    audio.src = replyAudioUrl; audio.hidden = false; state('Speaking…');
    await audio.play();
    if ((current !== generation || currentTurn !== turn) && audio.src === replyAudioUrl) audio.pause();
  } catch (e) {
    if (current === generation && currentTurn === turn) { await stop(); error(e.name === 'NotAllowedError' ? 'Audio playback was blocked. Use the audio player to hear the reply, then start listening again.' : e.message); }
  } finally { if (current === generation && request === controller) { request = null; controls(); } }
}
async function submitInterrupt(pcm, current, restartCapture = true) {
  // The worklet pauses after each speech segment. Always restart it, including while a check is pending.
  if (restartCapture) resumeCapture();
  if (current !== generation || !supportsInterrupt || !ready || !controlEnabled || mode === 'off') return;
  if (!pcm || pcm.byteLength < 9600 || pcm.byteLength > 48000 * 2 * 20 || pcm.byteLength % 2) return;
  if (interruption) {
    // Retain only the most recent bounded clip, never an unbounded queue of conversations.
    pendingInterrupt = { pcm, current };
    state('Checking speech · Latest interruption queued'); return;
  }
  const controller = new AbortController(); interruption = controller;
  try {
    const response = await fetch('/api/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Voice-Token': token }, body: pcm, signal: controller.signal });
    const result = await response.json();
    if (current !== generation) return;
    if (!response.ok || !result.success) throw new Error(result.reason || 'Could not check spoken interruption. Use the stop button or F9.');
    if (result.stopped) { message($('player').textContent, result.transcript); message('Control', 'Stopped.'); stoppedReply(); }
    // Non-stop speech is intentionally ignored, never submitted as a new command.
  } catch (e) {
    if (current === generation && !controller.signal.aborted) error(e.message);
  } finally {
    if (interruption === controller) {
      interruption = null;
      const next = pendingInterrupt; pendingInterrupt = null;
      // Start synchronously before a new normal command can overtake this older stop clip.
      if (next && next.current === generation) void submitInterrupt(next.pcm, next.current, false);
    }
  }
}
audio.addEventListener('ended', () => {
  // Replaying an older reply must not rearm the mic while a newer request is in flight.
  if (request) return;
  busy = false;
  if (mode === 'auto' && ready && controlEnabled) { if (!supportsInterrupt) processor?.port.postMessage({ type: 'mode', mode: 'auto' }); state('Listening…'); }
  else if (mode === 'auto' && !controlEnabled) { state('Mic ready · Press F8 in Minecraft'); }
  else if (mode === 'manual') { void stop(false); }
  controls();
});
audio.addEventListener('error', () => { if (busy) void stop().then(() => error('Browser audio playback failed. Your text reply is shown below.')); });
audio.addEventListener('play', () => { if (mode !== 'off') { busy = true; if (!supportsInterrupt) processor?.port.postMessage({ type: 'pause' }); state(supportsInterrupt ? 'Speaking · Say “stop” to interrupt' : 'Speaking…'); controls(); } });
$('handsfree').addEventListener('click', () => void start('auto'));
$('manual').addEventListener('click', () => { if (mode === 'manual') processor?.port.postMessage({ type: 'flush' }); else void start('manual'); });
$('stop').addEventListener('click', () => void stop());
window.addEventListener('pagehide', () => { void stop(); if (audioUrl) URL.revokeObjectURL(audioUrl); });
void refresh(true); setInterval(() => void refresh(), 1000);
// Optional page-scoped tools never start a microphone or submit audio without the user's click.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  for (const tool of [
    { name: 'get_voice_panel_status', title: 'Voice panel status', description: 'Read microphone and bot connection state. Does not record or send audio.', annotations: { readOnlyHint: true, untrustedContentHint: false },
      run: () => ({ ready, mode, busy, state: $('state').textContent }) },
    { name: 'stop_listening', title: 'Stop listening and actions', description: 'Stop this panel microphone, cancel the pending voice turn, pause playback, and stop Minecraft control when supported. Does not undo completed game actions.', annotations: { readOnlyHint: false, untrustedContentHint: false },
      run: async () => { await stop(); return { mode, busy, state: $('state').textContent }; } }
  ]) {
    try { Promise.resolve(document.modelContext.registerTool({ name: tool.name, title: tool.title, description: tool.description, annotations: tool.annotations,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (input) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Expected an empty object'); return tool.run(); }
    }, { signal: lifecycle.signal })).catch(() => {}); } catch {}
  }
}
`;

export const captureWorklet = String.raw`
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.mode = 'off'; this.reset(); this.levelFrames = 0;
    this.port.onmessage = ({data}) => {
      if (data.type === 'mode') { this.mode = data.mode; this.reset(); }
      if (data.type === 'pause') { this.mode = 'off'; this.reset(); }
      if (data.type === 'flush' && this.mode === 'manual') this.finish();
    };
  }
  reset() { this.chunks = []; this.pre = []; this.samples = 0; this.voiced = 0; this.silent = 0; this.collecting = false; }
  finish() {
    if (this.samples < 4800 || (this.mode === 'auto' && this.voiced < 9600)) {
      this.reset(); this.port.postMessage({type:'empty'}); return;
    }
    const length = Math.min(this.samples, 48000 * 20);
    const pcm = new ArrayBuffer(length * 2), view = new DataView(pcm);
    let index = 0;
    for (const chunk of this.chunks) for (const value of chunk) {
      if (index >= length) break;
      const sample = Math.max(-1, Math.min(1, value));
      view.setInt16(index++ * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    this.mode = 'off'; this.reset(); this.port.postMessage({type:'audio', audio:pcm}, [pcm]);
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || this.mode === 'off') return true;
    let power = 0; for (const value of input) power += value * value;
    const level = Math.sqrt(power / input.length), loud = level > 0.018;
    this.levelFrames += input.length;
    if (this.levelFrames >= 4800) { this.port.postMessage({type:'level',level}); this.levelFrames = 0; }
    const chunk = input.slice();
    if (this.mode === 'auto' && !this.collecting) {
      this.pre.push(chunk); while (this.pre.length * input.length > 12000) this.pre.shift();
      if (!loud) return true;
      this.collecting = true; this.chunks = this.pre; this.pre = [];
      this.samples = this.chunks.reduce((n,c) => n+c.length,0); this.voiced = input.length;
      this.port.postMessage({type:'speech'}); return true;
    }
    this.chunks.push(chunk); this.samples += input.length;
    if (loud) { this.voiced += input.length; this.silent = 0; } else this.silent += input.length;
    if (this.samples >= 48000 * 20 || (this.mode === 'auto' && this.silent >= 48000 * 0.8)) this.finish();
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
`;

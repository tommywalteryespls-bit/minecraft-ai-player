import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import vm from 'node:vm';
import { BrowserVoiceServer, type BrowserVoiceBackend } from '../src/voice/browserServer.js';
import { browserHtml, browserScript, captureWorklet } from '../src/voice/browserPanel.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(converse?: BrowserVoiceBackend['converse'], interruptBackend: Pick<BrowserVoiceBackend, 'interrupt' | 'stop'> = {}, options: { unlimitedTurns?: boolean | (() => boolean) } = {}) {
  let calls = 0;
  const server = new BrowserVoiceServer({
    status: () => ({ aiName: 'Astra', owner: 'TestPlayer', ownerValid: true, enabled: true, connected: true }),
    converse: async (audio, signal) => {
      calls++;
      return converse ? converse(audio, signal) : { success: true, transcript: 'Follow me', reply: 'Following you.', audioBase64: 'bXAz', mimeType: 'audio/mpeg' };
    }, ...interruptBackend
  }, options);
  const url = await server.listen(0);
  const session = await (await fetch(`${url}/api/session`)).json() as { token: string };
  const headers = { Origin: url, 'X-Voice-Token': session.token, 'Content-Type': 'application/octet-stream' };
  return { server, url, headers, calls: () => calls };
}

test('local panel serves isolated assets and valid audio after a normally completed HTTP body', async (t) => {
  const f = await fixture(async (audio, signal) => {
    assert.equal(audio.length, 9600);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(signal.aborted, false, 'normal request completion must not cancel work');
    return { success: true, transcript: 'Follow me', reply: 'Following you.' };
  }); t.after(() => f.server.close());
  for (const route of ['/', '/app.js', '/capture.js']) {
    const response = await fetch(f.url + route); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.ok((await response.text()).length > 100);
  }
  const response = await fetch(`${f.url}/api/voice`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9600) });
  assert.equal(response.status, 200); assert.equal((await response.json() as { success: boolean }).success, true);
  assert.equal(f.calls(), 1);
});

test('missing token, cross-origin, invalid host and malformed audio cannot invoke AI', async (t) => {
  const f = await fixture(); t.after(() => f.server.close());
  const attempts: Array<{ headers: Record<string, string>; body?: Buffer; expected: number }> = [
    { headers: { ...f.headers, 'X-Voice-Token': '' }, expected: 403 },
    { headers: { ...f.headers, 'X-Voice-Token': 'é'.repeat(64) }, expected: 403 },
    { headers: { ...f.headers, Origin: 'https://evil.example' }, expected: 403 },
    { headers: { ...f.headers, Origin: 'null' }, expected: 403 },
    { headers: { ...f.headers, 'Content-Type': 'text/plain' }, expected: 415 },
    { headers: f.headers, body: Buffer.alloc(9), expected: 400 },
    { headers: f.headers, body: Buffer.alloc(9601), expected: 400 },
    { headers: f.headers, body: Buffer.alloc(1_920_002), expected: 413 }
  ];
  for (const item of attempts) {
    const response = await fetch(`${f.url}/api/voice`, { method: 'POST', headers: item.headers, body: Uint8Array.from(item.body ?? Buffer.alloc(9600)) });
    assert.equal(response.status, item.expected); await response.arrayBuffer();
  }
  const noOrigin = { ...f.headers } as Record<string, string>; delete noOrigin.Origin;
  assert.equal((await fetch(`${f.url}/api/voice`, { method: 'POST', headers: noOrigin, body: Buffer.alloc(9600) })).status, 403);
  const cross = await fetch(`${f.url}/api/session`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const wrongHost = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(f.url, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!); }); req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403); assert.equal(f.calls(), 0);
});

test('oversized chunked requests are bounded without relying on Content-Length', async (t) => {
  const f = await fixture(); t.after(() => f.server.close());
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${f.url}/api/voice`, { method: 'POST', headers: f.headers }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.write(Buffer.alloc(1_000_000)); req.end(Buffer.alloc(1_000_000));
  });
  assert.equal(status, 413); assert.equal(f.calls(), 0);
});

test('one panel turn at a time and closing the browser cancels the request signal', async (t) => {
  const started = deferred<void>(), aborted = deferred<void>();
  const f = await fixture(async (_audio, signal) => {
    started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
    return { success: false, reason: 'cancelled' };
  }); t.after(() => f.server.close());
  const controller = new AbortController();
  const first = fetch(`${f.url}/api/voice`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9600), signal: controller.signal });
  const rejected = assert.rejects(first, /abort/i);
  await started.promise;
  assert.equal((await fetch(`${f.url}/api/voice`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9600) })).status, 409);
  controller.abort(); await rejected; await aborted.promise; assert.equal(f.calls(), 1);
});

test('authenticated stop cancels the controller and promptly settles a pending main response', async (t) => {
  const started = deferred<void>(), done = deferred<void>();
  let signal!: AbortSignal, stops = 0;
  const f = await fixture(async (_audio, currentSignal) => {
    signal = currentSignal; started.resolve();
    await done.promise; // Deliberately ignores cancellation to test the HTTP cancellation fallback.
    return { success: true, reply: 'This late reply must not revive the stopped task.' };
  }, { stop: async () => { stops++; }, interrupt: async () => ({ success: true }) });
  t.after(() => { done.resolve(); return f.server.close(); });
  const first = fetch(`${f.url}/api/voice`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9600) });
  await started.promise;
  const unauthorized = await fetch(`${f.url}/api/stop`, { method: 'POST', headers: { ...f.headers, 'X-Voice-Token': '' } });
  assert.equal(unauthorized.status, 403); assert.equal(stops, 0); assert.equal(signal.aborted, false);
  const crossOrigin = await fetch(`${f.url}/api/stop`, { method: 'POST', headers: { ...f.headers, Origin: 'https://evil.example' } });
  assert.equal(crossOrigin.status, 403); assert.equal(stops, 0);
  const stopped = await fetch(`${f.url}/api/stop`, { method: 'POST', headers: f.headers });
  assert.equal((await stopped.json() as { stopped: boolean }).stopped, true);
  assert.equal(signal.aborted, true); assert.equal(stops, 1);
  const reply = await first;
  assert.equal(reply.status, 200); assert.deepEqual(await reply.json(), { success: true, stopped: true });
  done.resolve();
});

test('concurrent speech is interrupt-only, serialized, authenticated, and cannot overtake its task', async (t) => {
  const mainStarted = deferred<void>(), firstInterrupt = deferred<void>(), allowInterrupt = deferred<void>();
  let interruptions = 0, stopped = false, mainSignal!: AbortSignal;
  const f = await fixture(async (_audio, signal) => {
    mainSignal = signal; mainStarted.resolve();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    return { success: false };
  }, {
    stop: async () => { stopped = true; },
    interrupt: async (_audio, signal) => {
      interruptions++; firstInterrupt.resolve(); await allowInterrupt.promise; signal.throwIfAborted();
      if (interruptions === 1) return { success: true, transcript: 'mine another block', stopped: false };
      stopped = true; return { success: true, transcript: 'stop', stopped: true };
    }
  }); t.after(() => f.server.close());
  const first = fetch(`${f.url}/api/voice`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9600) });
  await mainStarted.promise;
  const invalid = await fetch(`${f.url}/api/interrupt`, { method: 'POST', headers: { ...f.headers, 'X-Voice-Token': '' }, body: Buffer.alloc(9600) });
  assert.equal(invalid.status, 403); assert.equal(interruptions, 0);
  assert.equal((await fetch(`${f.url}/api/interrupt`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9601) })).status, 400);
  assert.equal(interruptions, 0);
  const interruption = fetch(`${f.url}/api/interrupt`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9600) });
  await firstInterrupt.promise;
  assert.equal((await fetch(`${f.url}/api/interrupt`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9600) })).status, 409);
  assert.equal((await fetch(`${f.url}/api/voice`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9600) })).status, 409);
  allowInterrupt.resolve();
  assert.equal((await (await interruption).json() as { stopped: boolean }).stopped, false);
  assert.equal(stopped, false); assert.equal(mainSignal.aborted, false); assert.equal(f.calls(), 1);
  const accepted = await fetch(`${f.url}/api/interrupt`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9600) });
  assert.equal((await accepted.json() as { stopped: boolean }).stopped, true);
  assert.equal(mainSignal.aborted, true); assert.equal(stopped, true);
  assert.equal((await (await first).json() as { stopped: boolean }).stopped, true);
  assert.equal(f.calls(), 1, 'busy speech must never call converse');
});

test('unlimited turn option removes only the main 180-second timer and advertises interruption support', async (t) => {
  const delays: Array<number | undefined> = [];
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
    delays.push(args[1]); return Reflect.apply(originalTimeout, globalThis, args);
  });
  let continuous = true;
  const f = await fixture(undefined, { stop: async () => {}, interrupt: async () => ({ success: true }) }, { unlimitedTurns: () => continuous });
  t.after(() => f.server.close());
  const status = await (await fetch(`${f.url}/api/status`, { headers: f.headers })).json() as { supportsInterrupt: boolean; unlimitedTurns: boolean };
  assert.equal(status.supportsInterrupt, true); assert.equal(status.unlimitedTurns, true);
  const response = await fetch(`${f.url}/api/voice`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9600) });
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(delays.includes(180_000), false);
  continuous = false;
  const normal = await fetch(`${f.url}/api/voice`, { method: 'POST', headers: f.headers, body: Buffer.alloc(9600) });
  await normal.arrayBuffer(); assert.equal(delays.includes(180_000), true);
  const changed = await (await fetch(`${f.url}/api/status`, { headers: f.headers })).json() as { unlimitedTurns: boolean };
  assert.equal(changed.unlimitedTurns, false, 'switching controller mode restores the normal timeout for new turns');
});

test('backend status can disable interrupt support without removing methods after a server switch', async (t) => {
  let enabled = false, interruptions = 0;
  const server = new BrowserVoiceServer({
    status: () => ({ supportsInterrupt: enabled }), converse: async () => ({ success: true }), stop: async () => {},
    interrupt: async () => { interruptions++; return { success: true }; }
  }); t.after(() => server.close());
  const url = await server.listen(0);
  const status = await (await fetch(`${url}/api/session`)).json() as { token: string; supportsInterrupt: boolean };
  assert.equal(status.supportsInterrupt, false);
  const headers = { Origin: url, 'X-Voice-Token': status.token, 'Content-Type': 'application/octet-stream' };
  assert.equal((await fetch(`${url}/api/interrupt`, { method: 'POST', headers, body: Buffer.alloc(9600) })).status, 404);
  assert.equal(interruptions, 0);
  enabled = true;
  const reply = await fetch(`${url}/api/interrupt`, { method: 'POST', headers, body: Buffer.alloc(9600) });
  await reply.arrayBuffer(); assert.equal(reply.status, 200); assert.equal(interruptions, 1);
});

function worklet() {
  const messages: Array<{ type: string; audio?: ArrayBuffer }> = [];
  let Constructor: any;
  vm.runInNewContext(captureWorklet, {
    AudioWorkletProcessor: class { port = { postMessage: (data: typeof messages[number]) => messages.push(data), onmessage: null }; },
    registerProcessor: (_name: string, value: unknown) => { Constructor = value; }
  });
  const processor = new Constructor();
  const send = (data: unknown) => processor.port.onmessage({ data });
  const frames = (seconds: number, value: number) => {
    for (let n = 0; n < Math.ceil(seconds * 48000 / 128); n++) processor.process([[new Float32Array(128).fill(value)]]);
  };
  return { messages, processor, send, frames };
}

test('browser assets parse and hands-free silence generates no uploads', () => {
  new vm.Script(browserScript);
  assert.match(browserHtml, /Start hands-free/);
  assert.doesNotMatch(browserHtml + browserScript, /sk-proj-|apiKey\s*:/);
  const f = worklet(); f.send({ type: 'mode', mode: 'auto' });
  f.frames(30, 0);
  assert.equal(f.messages.filter((m) => m.type === 'audio').length, 0);
  assert.ok(f.processor.pre.length <= 94, 'silence pre-roll memory must remain bounded');
});

test('hands-free segments speech into 48 kHz little-endian PCM and pauses until playback completes', () => {
  const f = worklet(); f.send({ type: 'mode', mode: 'auto' });
  f.frames(.3, 0); f.frames(.5, .3); f.frames(.9, 0);
  const audio = f.messages.filter((m) => m.type === 'audio'); assert.equal(audio.length, 1);
  assert.ok(audio[0]!.audio!.byteLength > 48_000);
  assert.equal(audio[0]!.audio!.byteLength % 2, 0);
  assert.equal(f.processor.mode, 'off'); f.frames(2, .5);
  assert.equal(f.messages.filter((m) => m.type === 'audio').length, 1);
});

test('manual capture can flush, stop clears recording, and continuous speech has a 20-second cap', () => {
  const f = worklet(); f.send({ type: 'mode', mode: 'manual' }); f.frames(.3, -.5); f.send({ type: 'flush' });
  const first = f.messages.find((m) => m.type === 'audio')!.audio!;
  assert.equal(new DataView(first).getInt16(0, true), -16384);
  f.send({ type: 'mode', mode: 'auto' }); f.frames(21, .3);
  assert.equal(f.messages.filter((m) => m.type === 'audio')[1]?.audio?.byteLength, 1_920_000);
  f.send({ type: 'mode', mode: 'manual' }); f.frames(.2, .3); f.send({ type: 'mode', mode: 'off' }); f.send({ type: 'flush' });
  assert.equal(f.messages.filter((m) => m.type === 'audio').length, 2);
});

test('replaying an old reply cannot unpause a pending request or create overlapping microphone uploads', async () => {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { textContent: '', children: [], append() {}, remove() {}, pause() {},
      addEventListener(type: string, callback: () => void) { this[type as keyof typeof this] = callback as never; } });
    return elements.get(id);
  };
  let uploads = 0;
  const sandbox = vm.createContext({
    document: { getElementById: element, createElement: () => ({ append() {} }) },
    window: { addEventListener() {} }, AbortController, setInterval() {},
    fetch: async (route: string, options?: { signal: AbortSignal }) => {
      if (route === '/api/session') return { ok: true, json: async () => ({ connected: true, enabled: true, ownerValid: true, token: 'mock-token' }) };
      uploads++;
      return new Promise((_resolve, reject) => options!.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
  });
  vm.runInContext(browserScript, sandbox); await new Promise((resolve) => setImmediate(resolve));
  const first = vm.runInContext("mode='auto'; submit(new ArrayBuffer(9600),generation)", sandbox) as Promise<void>;
  element('audio').ended();
  assert.equal(vm.runInContext('busy && Boolean(request)', sandbox), true);
  await vm.runInContext('submit(new ArrayBuffer(9600),generation)', sandbox);
  assert.equal(uploads, 1);
  await vm.runInContext('stop()', sandbox); await first;
  assert.equal(vm.runInContext("mode === 'off' && !request", sandbox), true);
});

test('Fabric can prepare its mic while disarmed, but captures and submits only after F8', async () => {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { textContent: '', children: [], append() {}, remove() {}, pause() {},
      addEventListener(type: string, callback: () => void) { this[type as keyof typeof this] = callback as never; } });
    return elements.get(id);
  };
  const messages: Array<{ type: string; mode?: string }> = [];
  let armed = false, uploads = 0;
  const sandbox = vm.createContext({
    document: { getElementById: element, createElement: () => ({ append() {} }) },
    window: { addEventListener() {} }, AbortController, setInterval() {}, messages,
    fetch: async (route: string) => {
      if (route === '/api/session' || route === '/api/status') return { ok: true, json: async () => ({
        connected: true, enabled: true, ownerValid: true, token: 'mock-token', controller: 'fabric', controlEnabled: armed
      }) };
      uploads++; throw new Error('unexpected upload');
    }
  });
  vm.runInContext(browserScript, sandbox); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('handsfree').disabled, false, 'mic startup cannot require arming while focused in browser');
  assert.equal(element('manual').disabled, true);
  vm.runInContext("mode='auto'; processor={port:{postMessage: (data) => messages.push(data)}}", sandbox);
  await vm.runInContext('submit(new ArrayBuffer(9600),generation)', sandbox);
  assert.equal(uploads, 0);
  armed = true; await vm.runInContext('refresh()', sandbox);
  assert.equal(element('state').textContent, 'Listening…');
  assert.deepEqual(messages.at(-1)?.mode, 'auto');
  armed = false; await vm.runInContext('refresh()', sandbox);
  assert.equal(messages.at(-1)?.type, 'pause');
  assert.match(element('state').textContent, /Press F8/);
  element('audio').ended();
  await vm.runInContext('submit(new ArrayBuffer(9600),generation)', sandbox);
  assert.equal(uploads, 0);
  assert.equal(vm.runInContext("mode === 'auto'", sandbox), true, 'disarming retains user-approved mic setup for rearming');
});

test('continuous panel captures stop speech during work and playback without running busy commands', async () => {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { textContent: '', children: [], append() {}, remove() {}, pause() {},
      addEventListener(type: string, callback: () => void) { this[type as keyof typeof this] = callback as never; } });
    return elements.get(id);
  };
  const capture: Array<{ type: string; mode?: string }> = [];
  const checks: Array<ReturnType<typeof deferred<{ success: boolean; transcript?: string; stopped?: boolean }>>> = [];
  const submittedInterrupts: number[] = [];
  let voiceCalls = 0, interruptCalls = 0, stopCalls = 0;
  const sandbox = vm.createContext({
    document: { getElementById: element, createElement: () => ({ append() {} }) },
    window: { addEventListener() {} }, AbortController, setInterval() {}, capture,
    fetch: async (route: string, options?: { signal: AbortSignal; body: ArrayBuffer }) => {
      if (route === '/api/session') return { ok: true, json: async () => ({ connected: true, enabled: true,
        ownerValid: true, token: 'mock-token', supportsInterrupt: true, unlimitedTurns: true, controller: 'fabric' }) };
      if (route === '/api/stop') { stopCalls++; return { ok: true }; }
      if (route === '/api/interrupt') {
        submittedInterrupts.push(new Uint8Array(options!.body)[0]!);
        interruptCalls++; const check = deferred<{ success: boolean; transcript?: string; stopped?: boolean }>(); checks.push(check);
        return { ok: true, json: () => check.promise };
      }
      voiceCalls++;
      return new Promise((_resolve, reject) => options!.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
  });
  vm.runInContext(browserScript, sandbox); await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(browserScript, /SpeechRecognition/);
  assert.match(element('listeningHelp').textContent, /headphones/);
  vm.runInContext("mode='auto'; processor={port:{postMessage: (data) => capture.push(data)}, disconnect(){}}", sandbox);
  const first = vm.runInContext('submit(new ArrayBuffer(9600),generation)', sandbox) as Promise<void>;
  assert.equal(capture.at(-1)?.mode, 'auto', 'capture must remain active during reasoning');
  const speech = vm.runInContext('submit(new ArrayBuffer(9600),generation)', sandbox) as Promise<void>;
  await vm.runInContext('submit(new Uint8Array(9600).fill(7).buffer,generation)', sandbox);
  await vm.runInContext('submit(new Uint8Array(9600).fill(9).buffer,generation)', sandbox);
  await vm.runInContext('submit(new ArrayBuffer(1920002),generation)', sandbox);
  assert.equal(interruptCalls, 1, 'only one interruption may be transcribed at once');
  assert.equal(capture.at(-1)?.mode, 'auto', 'queued concurrent chunks must still rearm VAD');
  assert.equal(vm.runInContext('pendingInterrupt.pcm.byteLength', sandbox), 9600, 'queued speech is a single size-bounded clip');
  checks[0]!.resolve({ success: true, transcript: 'mine another block', stopped: false }); await speech;
  assert.equal(interruptCalls, 2, 'the latest interruption captured while STT was pending must be checked next');
  assert.equal(submittedInterrupts[1], 9, 'only the latest valid queued clip is retained');
  assert.equal(voiceCalls, 1); assert.equal(vm.runInContext('busy && Boolean(request)', sandbox), true);
  await vm.runInContext('submit(new Uint8Array(9600).fill(8).buffer,generation)', sandbox);
  checks[1]!.resolve({ success: true, transcript: 'stop', stopped: true }); await new Promise((resolve) => setImmediate(resolve)); await first;
  assert.equal(vm.runInContext("mode === 'auto' && !busy && !request", sandbox), true, 'spoken stop cancels the turn but preserves hands-free microphone setup');
  assert.equal(vm.runInContext('pendingInterrupt === null', sandbox), true, 'recognized stop clears queued stale speech');
  assert.equal(interruptCalls, 2, 'queued speech after a recognized stop must not produce another request');
  assert.equal(voiceCalls, 1);
  const beforePlayback = capture.length;
  element('audio').play();
  assert.equal(capture.length, beforePlayback, 'playback must not pause capture or reset speech already in progress');
  const playbackSpeech = vm.runInContext('submit(new ArrayBuffer(9600),generation)', sandbox) as Promise<void>;
  checks[2]!.resolve({ success: true, transcript: 'stop', stopped: true }); await playbackSpeech;
  assert.equal(interruptCalls, 3); assert.equal(voiceCalls, 1);
  // This segment began during playback, but playback finished before VAD delivered its final PCM.
  vm.runInContext('busy = false', sandbox);
  const spanningSpeech = vm.runInContext('submit(new ArrayBuffer(9600),generation,true)', sandbox) as Promise<void>;
  checks[3]!.resolve({ success: true, transcript: 'mine another block', stopped: false }); await spanningSpeech;
  assert.equal(interruptCalls, 4); assert.equal(voiceCalls, 1, 'speech begun while busy must never become a new task after playback ends');
  const lateSpeech = vm.runInContext('submit(new ArrayBuffer(9600),generation,true)', sandbox) as Promise<void>;
  await vm.runInContext('submit(new ArrayBuffer(9600),generation,true)', sandbox);
  await vm.runInContext('stop()', sandbox);
  checks[4]!.resolve({ success: true, transcript: 'mine another block', stopped: false }); await lateSpeech;
  assert.equal(interruptCalls, 5, 'full stop clears the queued clip and stale callbacks cannot upload it');
  assert.equal(vm.runInContext('pendingInterrupt === null', sandbox), true);
  assert.equal(stopCalls, 1, 'the stop button must call the server controller stop endpoint');
});

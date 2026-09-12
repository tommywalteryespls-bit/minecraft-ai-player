import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ServerProfileLoader } from '../src/minecraft/serverProfiles/profileLoader.js';
import { pcm16le48kTo24k, pcmToWav } from '../src/voice/audioUtils.js';

test('example server profiles are valid and selectable by id', async () => {
  const loader = new ServerProfileLoader(path.resolve('servers'));
  const local = await loader.load('local-survival');
  const multiplayer = await loader.load('multiplayer-example');
  assert.equal(local.host, 'localhost');
  assert.equal(multiplayer.extensions?.semanticActions.inspect_market?.command, '/ah');
});

test('voice PCM is downsampled and wrapped in a valid WAV container', () => {
  const pcm = Buffer.alloc(480 * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE((offset / 2) % 2000, offset);
  const downsampled = pcm16le48kTo24k(pcm);
  assert.equal(downsampled.length, pcm.length / 2);
  const wav = pcmToWav(pcm);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt32LE(40), pcm.length);
});

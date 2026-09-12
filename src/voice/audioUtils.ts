export function pcm16le48kTo24k(input: Buffer): Buffer {
  const output = Buffer.allocUnsafe(Math.floor(input.length / 4) * 2);
  let outputOffset = 0;
  for (let inputOffset = 0; inputOffset + 3 < input.length; inputOffset += 4) {
    const first = input.readInt16LE(inputOffset);
    const second = input.readInt16LE(inputOffset + 2);
    output.writeInt16LE(Math.round((first + second) / 2), outputOffset);
    outputOffset += 2;
  }
  return output.subarray(0, outputOffset);
}

export function pcmToWav(pcm: Buffer, sampleRate = 48_000, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sampleRate = 32000;
const notes = [['C5', 72], ['D5', 74], ['E5', 76], ['G5', 79], ['A5', 81], ['C6', 84]];

function wav(samples) {
  const output = Buffer.alloc(44 + samples.length * 2);
  output.write('RIFF'); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, i) => output.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2));
  return output;
}

/** Bake the resonances once. Runtime playback needs only cached WAV buffers. */
export async function prepareGemNotes(outputDirectory = resolve('public/sounds')) {
  const impacts = await Promise.all([1, 2, 3].map(async index => {
    const bytes = await readFile(join(outputDirectory, `gem-${index}.wav`));
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(24) !== sampleRate || bytes.readUInt16LE(22) !== 1 || bytes.readUInt16LE(34) !== 16)
      throw new Error('Expected the prepared 32 kHz mono PCM impact sample');
    return Float32Array.from({ length: (bytes.length - 44) / 2 }, (_, i) => bytes.readInt16LE(44 + i * 2) / 32768);
  }));
  const manifest = JSON.parse(await readFile(join(outputDirectory, 'manifest.json'), 'utf8'))
    .filter(item => /^gem-[123]\.wav$/.test(item.output));
  for (const [index, [note, midi]] of notes.entries()) {
    const frequency = 440 * 2 ** ((midi - 69) / 12), duration = .38;
    const samples = new Float32Array(Math.round(sampleRate * duration)), impact = impacts[index % impacts.length];
    for (let i = 0; i < samples.length; i++) {
      const t = i / sampleRate;
      // A fast, rounded contact transient plus a clearly tuned low mode. The
      // slightly inharmonic upper modes decay sooner, like a small hard object.
      const attack = 1 - Math.exp(-t / .0009), release = Math.min(1, (samples.length - 1 - i) / (sampleRate * .035));
      const ring = .64 * Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t / .085) +
        .28 * Math.sin(2 * Math.PI * frequency * 2.01 * t) * Math.exp(-t / .05) +
        .19 * Math.sin(2 * Math.PI * frequency * 3.97 * t) * Math.exp(-t / .026) +
        .075 * Math.sin(2 * Math.PI * frequency * 5.43 * t) * Math.exp(-t / .012);
      samples[i] = (ring * attack + (impact[i] ?? 0) * .48 * Math.exp(-t / .018)) * release * release;
    }
    const peak = samples.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
    for (let i = 0; i < samples.length; i++) samples[i] *= .6 / peak;
    const bytes = wav(samples), output = `gem-note-${note}.wav`;
    await writeFile(join(outputDirectory, output), bytes);
    manifest.push({ input: `gem-${index % impacts.length + 1}.wav + synthesized resonances`, output, note, frequency,
      duration, peak: .6, bytes: bytes.length, generator: 'scripts/prepare-gem-notes.mjs' });
  }
  await writeFile(join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await prepareGemNotes();
  console.log(`Prepared ${notes.length} pitched gem samples; ${manifest.reduce((sum, item) => sum + item.bytes, 0)} bytes total.`);
}

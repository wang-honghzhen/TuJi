// Run with Electron: electron scripts/prepare-ui-sounds.cjs <downloaded source directory>
// Uses the project's existing Chromium decoder; no runtime audio processing dependency.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sourceDirectory = path.resolve(process.argv[2] || '.cache/ui-sound-candidates-20261015');
const outputDirectory = path.resolve('public/sounds');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'qixue-audio-build-')));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL('data:text/html,<title>Audio asset preparation</title>');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const samples = [
    ...[0, 1, 2].map(i => ({ input: `kenney-impactGlass_light_00${i}.ogg`, output: `gem-${i + 1}.wav`,
      duration: .11, rate: 1.4, peak: .44, highPass: 1400, lowPass: 8200, decay: .045 })),
  ];
  const manifest = [];
  for (const sample of samples) {
    const data = fs.readFileSync(path.join(sourceDirectory, sample.input)).toString('base64');
    const result = await window.webContents.executeJavaScript(`(async () => {
      const spec = ${JSON.stringify(sample)};
      const context = new OfflineAudioContext(1, 1, 32000);
      const bytes = Uint8Array.from(atob(${JSON.stringify(data)}), ch => ch.charCodeAt(0));
      const decoded = await context.decodeAudioData(bytes.buffer);
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const values = decoded.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += values[i] / decoded.numberOfChannels;
      }
      let peak = 0; for (const value of mono) peak = Math.max(peak, Math.abs(value));
      if (peak < .00001) throw new Error('Silent source ' + spec.input);
      let start = mono.findIndex(value => Math.abs(value) > peak * .008);
      start = Math.max(0, start - 32); // Keep a little pre-attack to avoid a clipped transient.
      const output = new Float32Array(Math.round(spec.duration * 32000));
      let outputPeak = 0;
      for (let i = 0; i < output.length; i++) {
        const position = start + i * spec.rate, a = Math.floor(position), fraction = position - a;
        const value = (mono[a] || 0) * (1 - fraction) + (mono[a + 1] || 0) * fraction;
        const attack = Math.min(1, i / 48), tail = Math.min(1, (output.length - 1 - i) / (spec.duration < .3 ? 2200 : 10000));
        output[i] = value * attack * tail * tail;
        outputPeak = Math.max(outputPeak, Math.abs(output[i]));
      }
      if (spec.highPass) {
        // A small crystal tick: remove the glassy low body, soften the very
        // high attack and damp its ring. Bake this into the asset, not each hover.
        const filteredContext = new OfflineAudioContext(1, output.length, 32000);
        const buffer = filteredContext.createBuffer(1, output.length, 32000);
        buffer.copyToChannel(output, 0);
        const source = filteredContext.createBufferSource(); source.buffer = buffer;
        const highPass = filteredContext.createBiquadFilter();
        highPass.type = 'highpass'; highPass.frequency.value = spec.highPass; highPass.Q.value = .6;
        const lowPass = filteredContext.createBiquadFilter();
        lowPass.type = 'lowpass'; lowPass.frequency.value = spec.lowPass; lowPass.Q.value = .6;
        source.connect(highPass); highPass.connect(lowPass); lowPass.connect(filteredContext.destination);
        source.start();
        const filtered = (await filteredContext.startRendering()).getChannelData(0);
        outputPeak = 0;
        for (let i = 0; i < output.length; i++) {
          const tail = Math.min(1, (output.length - 1 - i) / 192);
          output[i] = filtered[i] * Math.exp(-i / (spec.decay * 32000)) * tail;
          outputPeak = Math.max(outputPeak, Math.abs(output[i]));
        }
      }
      return { samples: Array.from(output, value => Math.round(value * spec.peak / outputPeak * 32767)), originalDuration: decoded.duration };
    })()`);
    const wav = Buffer.alloc(44 + result.samples.length * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(32000, 24); wav.writeUInt32LE(64000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    result.samples.forEach((value, i) => wav.writeInt16LE(value, 44 + i * 2));
    fs.writeFileSync(path.join(outputDirectory, sample.output), wav);
    manifest.push({ ...sample, bytes: wav.length, originalDuration: result.originalDuration });
  }
  fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.copyFileSync(path.join(sourceDirectory, 'kenney-License.txt'), path.join(outputDirectory, 'KENNEY-LICENSE.txt'));
  const prepared = await (await import('./prepare-gem-notes.mjs')).prepareGemNotes(outputDirectory);
  console.log(JSON.stringify({ samples: prepared.length, bytes: prepared.reduce((sum, item) => sum + item.bytes, 0) }));
  window.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });

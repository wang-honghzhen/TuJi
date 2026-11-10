import { DEFAULT_SOUND_SETTINGS, type SoundSettings } from '@/shared/soundSettings';
import { GEM_NOTES, GemMelody, type GemCue } from './gemMelody';

export type UiSound = 'button' | 'input';
const samples = [...[1, 2, 3].map(n => `gem-${n}`), ...GEM_NOTES.map(note => `gem-note-${note}`)];
interface Voice { source: AudioBufferSourceNode; gain: GainNode; kind: UiSound }

/** One audio graph for the entire window. No React updates or graph/layout work per sound. */
export class UiAudio {
  private settings: SoundSettings | null = null;
  private context?: AudioContext;
  private output?: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private voices: Voice[] = [];
  private loading?: Promise<void>;
  private abort?: AbortController;
  private retryAfter = 0;
  private activated = false;
  private generation = 0;
  private pending = 0;
  private idle?: ReturnType<typeof setTimeout>;
  private lastButton = -Infinity;
  private gem = 0;
  private inputMelody = new GemMelody();
  private previewMelody = new GemMelody();

  configure(settings: SoundSettings | null) {
    this.settings = settings ? { ...DEFAULT_SOUND_SETTINGS, ...settings } : null;
    if (!settings || !settings.volume || (!settings.buttonSounds && !settings.inputSounds)) { this.pause(); return; }
    for (const voice of [...this.voices]) if (!this.enabled(voice.kind)) this.stop(voice, true);
    if (!this.enabled('input')) this.inputMelody.reset();
  }
  private enabled(kind: UiSound) {
    return Boolean(this.settings && this.settings.volume > 0 && (kind === 'button' ? this.settings.buttonSounds : this.settings.inputSounds));
  }
  private visible() { return document.visibilityState === 'visible' && document.hasFocus(); }
  unlock() {
    this.activated = true;
    if (this.enabled('button') || this.enabled('input')) void this.prepare();
  }
  private async prepare() {
    if (!this.activated || !this.visible()) return;
    const generation = this.generation;
    try {
      if (!this.context || this.context.state === 'closed') {
        if (typeof AudioContext === 'undefined') return;
        this.context = new AudioContext({ latencyHint: 'interactive' });
        this.output = this.context.createGain(); this.output.gain.value = .65;
        this.output.connect(this.context.destination);
      }
      const context = this.context;
      if (context.state === 'suspended') await context.resume();
      if (generation !== this.generation || context !== this.context || !this.visible()) return;
      if (this.loading) return this.loading;
      if (this.buffers.size === samples.length || performance.now() < this.retryAfter) { this.scheduleIdle(); return; }
      this.abort = new AbortController(); const signal = this.abort.signal;
      const missing = samples.filter(name => !this.buffers.has(name));
      this.loading = Promise.allSettled(missing.map(async name => {
        const response = await fetch(`/sounds/${name}.wav`, { signal });
        if (!response.ok) throw new Error('Audio sample unavailable');
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        if (generation === this.generation) this.buffers.set(name, buffer);
      })).then(() => {
        if (generation !== this.generation) return;
        this.loading = undefined; this.abort = undefined;
        if (this.buffers.size < samples.length) this.retryAfter = performance.now() + 30000;
      });
      await this.loading;
      if (generation === this.generation) this.scheduleIdle();
    } catch { /* Audio device, autoplay or sample failures must never interrupt editing. */ }
  }
  play(kind: UiSound, previewVolume?: number) {
    if (!this.visible() || !this.activated || (previewVolume === undefined && !this.enabled(kind))) return;
    const volume = previewVolume ?? this.settings?.volume ?? 0;
    if (volume <= 0) return;
    const now = performance.now();
    if (kind === 'button' && now - this.lastButton < 80) return;
    if (kind === 'button') this.lastButton = now;
    // Use event time, not decode/resume completion time. Hover feedback and
    // settings previews each leave the typing phrase alone.
    const cue = kind === 'input' ? (previewVolume === undefined ? this.inputMelody : this.previewMelody).next(now) : undefined;
    const sequence = ++this.pending, generation = this.generation;
    const playReady = () => {
      if (generation !== this.generation || !this.visible() || (previewVolume === undefined && !this.enabled(kind))) return;
      this.start(kind, volume, cue);
    };
    if (this.context?.state === 'running' && this.buffers.size === samples.length) playReady();
    else void this.prepare().then(() => {
      // A single recent feedback may wait for decoding/resume; never replay a typing backlog.
      if (sequence === this.pending && performance.now() - now < 120) playReady();
    });
  }
  private start(kind: UiSound, volume: number, cue?: GemCue) {
    const context = this.context;
    if (!context || context.state !== 'running' || !this.output) return;
    if (kind === 'input' && !cue) return;
    const name = kind === 'button' ? `gem-${this.gem++ % 3 + 1}` : `gem-note-${cue!.note}`;
    const buffer = this.buffers.get(name); if (!buffer) return;
    // Keep the new keystroke audible; retire the oldest tail instead of dropping input feedback.
    while (this.voices.length >= 8) this.stop(this.voices[0]);
    if (kind === 'button') {
      const buttons = this.voices.filter(voice => voice.kind === 'button');
      if (buttons.length >= 2) this.stop(buttons[0]);
    }
    try {
      const source = context.createBufferSource(), gain = context.createGain();
      source.buffer = buffer; gain.gain.value = Math.max(0, Math.min(1, volume)) * (kind === 'button' ? .65 : .8 * cue!.strength);
      source.connect(gain); gain.connect(this.output);
      const voice = { source, gain, kind }; this.voices.push(voice);
      source.onended = () => { this.voices = this.voices.filter(v => v !== voice); source.disconnect(); gain.disconnect(); };
      source.start(); this.scheduleIdle();
    } catch { /* The audio device can disappear independently of the app. */ }
  }
  private stop(voice: Voice, immediate = false) {
    this.voices = this.voices.filter(v => v !== voice);
    try {
      const now = this.context?.currentTime ?? 0;
      if (immediate) { voice.source.disconnect(); voice.gain.disconnect(); voice.source.stop(); return; }
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + .012);
      voice.source.stop(now + .014);
    } catch { voice.source.disconnect(); voice.gain.disconnect(); }
  }
  private scheduleIdle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.pause(), 30000);
  }
  pause() {
    this.pending++; clearTimeout(this.idle);
    this.inputMelody.reset(); this.previewMelody.reset();
    for (const voice of [...this.voices]) this.stop(voice, true);
    if (this.context?.state === 'running') void this.context.suspend().catch(() => undefined);
  }
  dispose() {
    this.pause(); this.generation++; this.abort?.abort(); this.abort = undefined; this.loading = undefined;
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => undefined);
    this.context = undefined; this.output = undefined; this.buffers.clear(); this.activated = false;
  }
}

export const uiAudio = new UiAudio();

// Authentic Lamborghini Revuelto V12 Engine Sound Engine
// Realistic 6.5L Naturally Aspirated V12 (L545) with 9,500 RPM redline:
//  - Deep, rhythmic 1,000 RPM idle thrum with mechanical valvetrain character
//  - Screaming high-pitched V12 full-throttle acceleration howl
//  - Crisp ignition-cut gearshifts with explosive exhaust pops and backfire flames
//  - Overrun crackles and burble on deceleration
//  - Enclosed resonant tunnel muffling
//  - Dual European acoustic horn and dynamic police siren
import { GEAR_TOP, IDLE_RPM, REDLINE, pickGear } from "./gearbox";

const MASTER = 0.82;
const GRAIN = 0.12; // seconds
const HOP = 0.05; // grain spacing (≈60% overlap)
const LOOKAHEAD = 0.12;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Map engine rpm to the fundamental acoustic pitch of the Lamborghini V12. */
export const rpmToHz = (rpm: number) => 80 + ((rpm - 1500) * 260) / 7000;

// Pitch reference table for granular playback scheduler (75 Hz idle to 320 Hz high rev)
const LOAD_PITCH = [
  75, 79, 85, 88, 89, 91, 95, 98, 102, 105, 109, 113, 117, 121, 124, 126, 129, 131, 134, 138, 141, 143, 146, 149, 151,
  154, 156, 158, 162, 166, 171, 177, 183, 189, 193, 196, 197, 199, 201, 203, 205, 208, 210, 212, 213, 214, 216, 220,
  224, 229, 233, 238, 242, 247, 251, 256, 260, 265, 270, 275, 280, 285, 289, 294, 299, 304, 309, 312, 316, 320,
];
const PITCH_T0 = 0.04;
const PITCH_DT = 0.04;
const IDLE_HZ = 72; // fundamental firing frequency of V12 idle (6 pulses/rev at 1000 RPM ≈ 100 Hz / bank resonance ≈ 72 Hz)

const SINE_WINDOW = (() => {
  const n = 64;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = Math.sin((Math.PI * i) / (n - 1));
  return w;
})();

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  // Granular engine playback nodes
  private loadBus: GainNode | null = null;
  private loadFilter: BiquadFilterNode | null = null;
  private shiftGain: GainNode | null = null;
  private idleGain: GainNode | null = null;
  private idleSrc: AudioBufferSourceNode | null = null;

  // Real-time V12 synthesized harmonic engine nodes (guarantees instant, continuous sound)
  private synthGain: GainNode | null = null;
  private v12Osc1: OscillatorNode | null = null;
  private v12Osc2: OscillatorNode | null = null;
  private v12Osc3: OscillatorNode | null = null;
  private v12WaveShaper: WaveShaperNode | null = null;

  // Wind and tyre noise
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private loadBuf: AudioBuffer | null = null;
  private revBuf: AudioBuffer | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private muted = false;

  // Horn nodes
  private hornGain: GainNode | null = null;
  private hornOsc1: OscillatorNode | null = null;
  private hornOsc2: OscillatorNode | null = null;
  private hornFilter: BiquadFilterNode | null = null;

  // Police siren nodes
  private policeGain: GainNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private sirenLfo: OscillatorNode | null = null;
  private sirenLfoGain: GainNode | null = null;
  private policeEngineGain: GainNode | null = null;
  private policeEngineOsc: OscillatorNode | null = null;

  // Boost (KERS electric motor) nodes
  private boostGain: GainNode | null = null;
  private boostOsc: OscillatorNode | null = null;

  // Engine telemetry state
  private rpm = IDLE_RPM;
  private gear = 0;
  private hz = rpmToHz(IDLE_RPM);
  private loadOn = false;
  private throttle = false;
  private lastT = 0;
  private nextGrain = 0;
  private crackleUntil = 0;
  private inTunnel = false;

  unlock() {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;

      // Dynamics compressor to give aggressive, punchy exhaust presence without clipping
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 8;
      comp.ratio.value = 4.5;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      comp.connect(ctx.destination);

      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER;
      this.master.connect(comp);

      // Load (accelerating) chain: grains -> shift dip -> body EQ -> tone filter -> bus
      this.loadBus = ctx.createGain();
      this.loadBus.gain.value = 0;
      this.loadBus.connect(this.master);

      this.loadFilter = ctx.createBiquadFilter();
      this.loadFilter.type = "lowpass";
      this.loadFilter.frequency.value = 7500;
      this.loadFilter.Q.value = 0.7;
      this.loadFilter.connect(this.loadBus);

      // Deep V12 exhaust low-end boost (220 Hz low shelf)
      const body = ctx.createBiquadFilter();
      body.type = "lowshelf";
      body.frequency.value = 240;
      body.gain.value = 7;
      body.connect(this.loadFilter);

      this.shiftGain = ctx.createGain();
      this.shiftGain.connect(body);

      // Idle bus
      this.idleGain = ctx.createGain();
      this.idleGain.gain.value = 0;
      this.idleGain.connect(this.master);

      // Wind and road noise buffer
      const len = ctx.sampleRate * 2;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const nd = this.noiseBuf.getChannelData(0);
      let b = 0;
      for (let i = 0; i < len; i++) {
        b = 0.97 * b + 0.03 * (Math.random() * 2 - 1);
        nd[i] = b * 6 + (Math.random() * 2 - 1) * 0.15;
      }

      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = "bandpass";
      this.windFilter.frequency.value = 500;
      this.windFilter.Q.value = 0.5;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      this.windFilter.connect(this.windGain);
      this.windGain.connect(this.master);

      const wind = ctx.createBufferSource();
      wind.buffer = this.noiseBuf;
      wind.loop = true;
      wind.connect(this.windFilter);
      wind.start();

      // Police pursuit siren & engine setup
      this.setupPoliceAudio(ctx);

      // Boost KERS electric motor whine
      this.boostGain = ctx.createGain();
      this.boostGain.gain.value = 0;
      this.boostGain.connect(this.master);

      this.boostOsc = ctx.createOscillator();
      this.boostOsc.type = "sawtooth";
      this.boostOsc.frequency.value = 1400;

      const boostFilter = ctx.createBiquadFilter();
      boostFilter.type = "bandpass";
      boostFilter.frequency.value = 2200;
      boostFilter.Q.value = 3.0;

      this.boostOsc.connect(boostFilter);
      boostFilter.connect(this.boostGain);
      this.boostOsc.start();

      // Synthesize realistic Lamborghini V12 sound buffers directly in-memory!
      this.setupV12AudioBuffers(ctx);

      // Real-time continuous V12 synthesizer layer
      this.setupRealtimeV12Synth(ctx);
    }
    void this.ctx.resume();
  }

  // ---------- In-Memory Realistic Lamborghini V12 Acoustic Synthesis ----------
  private setupV12AudioBuffers(ctx: AudioContext) {
    try {
      // 1. Synthesize Authentic V12 Idle Loop (2 seconds seamless loop)
      const idleLen = ctx.sampleRate * 2;
      const idleBuf = ctx.createBuffer(1, idleLen, ctx.sampleRate);
      const idData = idleBuf.getChannelData(0);
      const fIdle = IDLE_HZ; // 72 Hz fundamental (Lamborghini L545 idle firing harmonic)

      for (let i = 0; i < idleLen; i++) {
        const t = i / ctx.sampleRate;
        const phase = (t * fIdle) % 1;
        // Asymmetric cylinder exhaust pressure pulse profile
        const p1 = Math.sin(phase * 2 * Math.PI);
        const p2 = Math.sin(phase * 4 * Math.PI + 0.3) * 0.65; // 2nd harmonic (bank pulse)
        const p3 = Math.sin(phase * 6 * Math.PI + 0.6) * 0.42; // 3rd harmonic (collector merge)
        const p6 = Math.sin(phase * 12 * Math.PI + 1.1) * 0.28; // 6th harmonic (full firing cycle)
        // Sub-bass exhaust thrum (36 Hz sub-octave)
        const sub = Math.sin(t * 36 * 2 * Math.PI) * 0.3;
        // Mechanical valvetrain high-frequency rattle (480 Hz)
        const valve = Math.sin(t * 480 * 2 * Math.PI) * 0.08 * (Math.sin(phase * 2 * Math.PI) > 0 ? 1 : 0);
        // Slight natural cylinder-to-cylinder pressure modulation (lobed cam idle)
        const jitter = 1 + 0.08 * Math.sin(t * 7.5 * 2 * Math.PI);

        const raw = (p1 + p2 + p3 + p6 + sub + valve) * jitter;
        idData[i] = Math.tanh(raw * 1.35) * 0.55;
      }

      // Smooth loop boundaries
      const fadeLen = Math.floor(ctx.sampleRate * 0.05);
      for (let i = 0; i < fadeLen; i++) {
        const frac = i / fadeLen;
        idData[i] = idData[i]! * frac + idData[idleLen - fadeLen + i]! * (1 - frac);
      }

      this.idleSrc = ctx.createBufferSource();
      this.idleSrc.buffer = idleBuf;
      this.idleSrc.loop = true;
      this.idleSrc.connect(this.idleGain!);
      this.idleSrc.start();

      // 2. Synthesize Full-Throttle V12 Load Pull Buffer (3.5s sweep from 75 Hz to 320 Hz)
      const loadLen = Math.floor(ctx.sampleRate * 3.5);
      const loadBuf = ctx.createBuffer(1, loadLen, ctx.sampleRate);
      const ldData = loadBuf.getChannelData(0);

      let curPhase = 0;
      for (let i = 0; i < loadLen; i++) {
        const t = i / ctx.sampleRate;
        const progress = t / 3.5;
        // Frequency follows LOAD_PITCH curve from 75 Hz to 318 Hz
        const freq = 75 + Math.pow(progress, 1.4) * (318 - 75);
        curPhase += (freq / ctx.sampleRate) * 2 * Math.PI;

        // V12 exhaust harmonic profile: screaming naturally aspirated character
        const h1 = Math.sin(curPhase);
        const h2 = Math.sin(curPhase * 2 + 0.25) * 0.68;
        const h3 = Math.sin(curPhase * 3 + 0.5) * 0.48;
        const h4 = Math.sin(curPhase * 4 + 0.7) * 0.35;
        const h6 = Math.sin(curPhase * 6 + 1.2) * (0.2 + progress * 0.35); // high RPM metallic scream!
        // High rev air intake resonance (1800 Hz overtone)
        const intake = Math.sin(curPhase * 8.5) * (0.05 + progress * 0.28);

        const raw = (h1 + h2 + h3 + h4 + h6 + intake) * (1 + 0.05 * (Math.random() * 2 - 1));
        ldData[i] = Math.tanh(raw * 1.4) * 0.6;
      }
      this.loadBuf = loadBuf;

      // 3. Synthesize Rev blip (start blip: idle -> 7500 RPM -> idle in 1.2s)
      const revLen = Math.floor(ctx.sampleRate * 1.2);
      const revBuf = ctx.createBuffer(1, revLen, ctx.sampleRate);
      const rvData = revBuf.getChannelData(0);
      let rPhase = 0;
      for (let i = 0; i < revLen; i++) {
        const t = i / ctx.sampleRate;
        // Peak rev curve at t = 0.35s
        const env = t < 0.35 ? t / 0.35 : Math.exp(-(t - 0.35) * 3.8);
        const freq = 75 + env * 230; // up to ~305 Hz (approx 7,500 RPM)
        rPhase += (freq / ctx.sampleRate) * 2 * Math.PI;

        const h1 = Math.sin(rPhase);
        const h2 = Math.sin(rPhase * 2) * 0.6;
        const h3 = Math.sin(rPhase * 3) * 0.45;
        const h6 = Math.sin(rPhase * 6) * (0.2 + env * 0.3);
        rvData[i] = Math.tanh((h1 + h2 + h3 + h6) * 1.3) * 0.65 * (t < 0.05 ? t / 0.05 : 1);
      }
      this.revBuf = revBuf;

      // Start the granular engine scheduler
      this.timer = setInterval(() => this.tick(), 20);
    } catch (err) {
      console.warn("V12 audio synthesis warning:", err);
    }
  }

  // ---------- Real-Time Synthesized V12 Harmonic Layer ----------
  private setupRealtimeV12Synth(ctx: AudioContext) {
    if (!this.master) return;

    this.synthGain = ctx.createGain();
    this.synthGain.gain.value = 0.32; // Active base level
    this.synthGain.connect(this.master);

    // Wave shaper for exhaust manifold throatiness
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i * 2) / 256 - 1;
      curve[i] = Math.tanh(x * 1.8);
    }
    shaper.curve = curve;
    shaper.connect(this.synthGain);
    this.v12WaveShaper = shaper;

    // Harmonic 1 (Fundamental firing frequency)
    this.v12Osc1 = ctx.createOscillator();
    this.v12Osc1.type = "sawtooth";
    this.v12Osc1.frequency.value = rpmToHz(IDLE_RPM);

    // Harmonic 2 (Bank pulse)
    this.v12Osc2 = ctx.createOscillator();
    this.v12Osc2.type = "sawtooth";
    this.v12Osc2.frequency.value = rpmToHz(IDLE_RPM) * 2;

    // Harmonic 3 (Collector roar)
    this.v12Osc3 = ctx.createOscillator();
    this.v12Osc3.type = "triangle";
    this.v12Osc3.frequency.value = rpmToHz(IDLE_RPM) * 3;

    const g1 = ctx.createGain();
    g1.gain.value = 0.45;
    this.v12Osc1.connect(g1);
    g1.connect(shaper);

    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    this.v12Osc2.connect(g2);
    g2.connect(shaper);

    const g3 = ctx.createGain();
    g3.gain.value = 0.22;
    this.v12Osc3.connect(g3);
    g3.connect(shaper);

    this.v12Osc1.start();
    this.v12Osc2.start();
    this.v12Osc3.start();
  }

  private setupPoliceAudio(ctx: AudioContext) {
    if (!this.master) return;
    this.policeGain = ctx.createGain();
    this.policeGain.gain.value = 0;
    this.policeGain.connect(this.master);

    const sirenFilter = ctx.createBiquadFilter();
    sirenFilter.type = "bandpass";
    sirenFilter.frequency.value = 850;
    sirenFilter.Q.value = 1.6;
    sirenFilter.connect(this.policeGain);

    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = "sawtooth";
    this.sirenOsc.frequency.value = 750;

    this.sirenLfo = ctx.createOscillator();
    this.sirenLfo.type = "sine";
    this.sirenLfo.frequency.value = 1.4;

    this.sirenLfoGain = ctx.createGain();
    this.sirenLfoGain.gain.value = 240;

    this.sirenLfo.connect(this.sirenLfoGain);
    this.sirenLfoGain.connect(this.sirenOsc.frequency);

    const sirenToneGain = ctx.createGain();
    sirenToneGain.gain.value = 0.28;
    this.sirenOsc.connect(sirenFilter);
    sirenFilter.connect(sirenToneGain);
    sirenToneGain.connect(this.policeGain);

    this.sirenOsc.start();
    this.sirenLfo.start();

    this.policeEngineOsc = ctx.createOscillator();
    this.policeEngineOsc.type = "triangle";
    this.policeEngineOsc.frequency.value = 135;

    const peFilter = ctx.createBiquadFilter();
    peFilter.type = "lowpass";
    peFilter.frequency.value = 900;

    this.policeEngineGain = ctx.createGain();
    this.policeEngineGain.gain.value = 0;

    this.policeEngineOsc.connect(peFilter);
    peFilter.connect(this.policeEngineGain);
    this.policeEngineGain.connect(this.policeGain);
    this.policeEngineOsc.start();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopHorn();
    void this.ctx?.close();
    this.ctx = null;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : MASTER, this.ctx.currentTime, 0.05);
  }

  /** One-shot real rev blip (played when the race starts). */
  rev() {
    if (!this.ctx || !this.master) return;
    const play = () => {
      if (!this.revBuf || !this.ctx || !this.master) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this.revBuf;
      const g = this.ctx.createGain();
      g.gain.value = 0.85;
      src.connect(g);
      g.connect(this.master);
      src.start();
    };
    play();
  }

  // ---- Dual car horn (Buzina) ----
  startHorn(inTunnel = false) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (this.hornGain) return;

    const t = ctx.currentTime;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0, t);
    hg.gain.linearRampToValueAtTime(0.52, t + 0.03);

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = inTunnel ? 720 : 1200;
    filter.Q.value = inTunnel ? 2.5 : 1.2;
    filter.connect(hg);
    hg.connect(this.master);

    const osc1 = ctx.createOscillator();
    osc1.type = "sawtooth";
    osc1.frequency.value = 415;

    const osc2 = ctx.createOscillator();
    osc2.type = "sawtooth";
    osc2.frequency.value = 520;

    osc1.connect(filter);
    osc2.connect(filter);

    osc1.start(t);
    osc2.start(t);

    this.hornGain = hg;
    this.hornOsc1 = osc1;
    this.hornOsc2 = osc2;
    this.hornFilter = filter;
  }

  stopHorn() {
    const ctx = this.ctx;
    if (!ctx || !this.hornGain) return;
    const t = ctx.currentTime;
    this.hornGain.gain.cancelScheduledValues(t);
    this.hornGain.gain.setValueAtTime(this.hornGain.gain.value, t);
    this.hornGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);

    const o1 = this.hornOsc1;
    const o2 = this.hornOsc2;
    const hg = this.hornGain;
    setTimeout(() => {
      try {
        o1?.stop();
        o2?.stop();
        o1?.disconnect();
        o2?.disconnect();
        hg.disconnect();
      } catch {
        // cleanup ignore
      }
    }, 100);

    this.hornGain = null;
    this.hornOsc1 = null;
    this.hornOsc2 = null;
    this.hornFilter = null;
  }

  setPolice(gap: number, active: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.policeGain || !this.sirenLfo || !this.policeEngineGain) return;
    const t = ctx.currentTime;

    if (!active) {
      this.policeGain.gain.setTargetAtTime(0, t, 0.2);
      this.policeEngineGain.gain.setTargetAtTime(0, t, 0.2);
      return;
    }

    let vol = 0;
    let lfoRate = 1.3;
    if (gap >= 220) {
      vol = 0.06 * Math.max(0, 1 - (gap - 220) / 380);
      lfoRate = 1.2;
    } else if (gap >= 120) {
      const p = 1 - (gap - 120) / 100;
      vol = 0.06 + p * 0.18;
      lfoRate = 1.4 + p * 0.4;
    } else if (gap >= 50) {
      const p = 1 - (gap - 50) / 70;
      vol = 0.24 + p * 0.28;
      lfoRate = 1.8 + p * 1.0;
    } else {
      const p = 1 - Math.max(0, gap) / 50;
      vol = 0.52 + p * 0.33;
      lfoRate = 2.8 + p * 1.2;
    }

    this.policeGain.gain.setTargetAtTime(clamp(vol, 0, 0.85), t, 0.15);
    this.sirenLfo.frequency.setTargetAtTime(lfoRate, t, 0.2);

    const engVol = gap < 120 ? clamp((1 - gap / 120) * 0.22, 0, 0.22) : 0;
    this.policeEngineGain.gain.setTargetAtTime(engVol, t, 0.15);
  }

  // ---- Granular Engine Scheduler ----
  private tick() {
    const ctx = this.ctx;
    const buf = this.loadBuf;
    if (!ctx || !buf || !this.shiftGain || ctx.state !== "running") return;
    const now = ctx.currentTime;
    if (this.nextGrain < now) this.nextGrain = now + 0.01;
    while (this.nextGrain < now + LOOKAHEAD) {
      if (this.loadOn) this.grain(buf, this.nextGrain);
      this.nextGrain += HOP * rnd(0.85, 1.15);
    }
    if (now < this.crackleUntil && Math.random() < 0.32) this.pop(now + rnd(0.01, 0.05), rnd(0.2, 0.5));
  }

  private grain(buf: AudioBuffer, at: number) {
    const ctx = this.ctx!;
    const hz = this.hz;
    const cands: number[] = [];
    let nearest = 0;
    for (let i = 0; i < LOAD_PITCH.length; i++) {
      const p = LOAD_PITCH[i]!;
      if (Math.abs(p - hz) < hz * 0.05) cands.push(i);
      if (Math.abs(p - hz) < Math.abs((LOAD_PITCH[nearest] ?? 0) - hz)) nearest = i;
    }
    const idx = cands.length ? cands[Math.floor(Math.random() * cands.length)]! : nearest;
    const rate = clamp(hz / (LOAD_PITCH[idx] ?? hz), 0.7, 1.25);
    const span = GRAIN * rate;
    const offset = clamp(PITCH_T0 + idx * PITCH_DT - span / 2 + rnd(-0.02, 0.02), 0, buf.duration - span - 0.01);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueCurveAtTime(SINE_WINDOW, at, GRAIN);
    src.connect(g);
    g.connect(this.shiftGain!);
    src.start(at, offset, span + 0.01);
    src.stop(at + GRAIN + 0.02);
  }

  /** Short exhaust "pop" (overrun crackle / gear change). */
  pop(at: number, level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf || !this.master) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = this.inTunnel ? rnd(350, 950) : rnd(550, 1700);
    bp.Q.value = this.inTunnel ? 2.2 : 1.2;
    const g = ctx.createGain();
    const d = rnd(0.025, 0.07);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, at + d);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(at, rnd(0, 1.5), d + 0.02);
  }

  fireExhaustBackfire() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.pop(t + 0.01, 0.85);
    this.pop(t + 0.05, 0.72);
    this.pop(t + 0.09, 0.55);
  }

  private shift(t: number) {
    const s = this.shiftGain;
    if (!s) return;
    s.gain.cancelScheduledValues(t);
    s.gain.setValueAtTime(1, t);
    // Ignition cut dip on shift
    s.gain.linearRampToValueAtTime(0.18, t + 0.04);
    s.gain.linearRampToValueAtTime(1, t + 0.16);
    this.pop(t + 0.02, 0.65);
    this.pop(t + 0.06, 0.45);
  }

  setEngine(speed: number, throttle: boolean, running: boolean, inTunnel = false, rain = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.idleGain || !this.loadBus || !this.loadFilter || !this.windGain || !this.windFilter)
      return;
    const t = ctx.currentTime;
    const dt = clamp(t - this.lastT, 0, 0.1);
    this.lastT = t;
    this.inTunnel = inTunnel;

    const rainHiss = rain > 0 ? rain * 0.22 : 0;
    const windTarget = running ? (inTunnel ? 0.12 : 0.22 + rainHiss) * (speed / 340) ** 2 : 0;
    this.windGain.gain.setTargetAtTime(windTarget, t, 0.2);
    this.windFilter.frequency.setTargetAtTime(
      inTunnel ? 320 + speed * 2 : rain > 0.3 ? 750 + speed * 3.5 : 350 + speed * 4,
      t,
      0.2,
    );

    if (!running) {
      this.idleGain.gain.setTargetAtTime(0, t, 0.15);
      this.loadBus.gain.setTargetAtTime(0, t, 0.15);
      if (this.synthGain) this.synthGain.gain.setTargetAtTime(0, t, 0.15);
      this.loadOn = false;
      this.rpm = IDLE_RPM;
      this.gear = 0;
      this.crackleUntil = 0;
      this.throttle = false;
      return;
    }

    // 8-speed gearbox logic
    const g = pickGear(this.gear, speed, throttle);
    if (g > this.gear && throttle) this.shift(t);
    this.gear = g;

    // RPM model for Lamborghini Revuelto (9,500 RPM V12)
    let target = Math.max(IDLE_RPM, (REDLINE * speed) / (GEAR_TOP[g] ?? 352));
    if (throttle && g === 0) target = Math.max(target, 3200 + speed * 45); // Launch clutch slip
    if (!throttle && speed < 12) target = IDLE_RPM;
    target = Math.min(target, 9500);

    const tau = target < this.rpm ? (throttle ? 0.05 : 0.18) : 0.07;
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt / tau));
    this.hz = rpmToHz(this.rpm);

    // Overrun crackles when lifting off throttle at high RPM
    if (this.throttle && !throttle && this.rpm > 4800) this.crackleUntil = t + 1.2;
    if (throttle) this.crackleUntil = 0;
    this.throttle = throttle;

    // Audio mix: accelerating = full-throttle roaring V12 pull; off throttle = deep idling burble
    const rpmN = clamp((this.rpm - IDLE_RPM) / (REDLINE - IDLE_RPM), 0, 1);
    const idleLevel = throttle ? clamp(1 - rpmN * 3, 0, 1) * 0.65 : clamp(1 - rpmN * 1.5, 0.35, 1) * 0.95;
    const loadLevel = throttle ? 0.85 + rpmN * 0.25 : rpmN > 0.05 ? 0.22 + rpmN * 0.2 : 0;
    this.loadOn = loadLevel > 0.01 || this.loadBus.gain.value > 0.02;

    this.idleGain.gain.setTargetAtTime(idleLevel, t, 0.1);
    this.loadBus.gain.setTargetAtTime(loadLevel, t, throttle ? 0.05 : 0.15);

    // Realtime harmonic V12 synthesizer frequencies and volume
    if (this.v12Osc1 && this.v12Osc2 && this.v12Osc3 && this.synthGain) {
      const oscFreq = this.hz;
      this.v12Osc1.frequency.setTargetAtTime(oscFreq, t, 0.06);
      this.v12Osc2.frequency.setTargetAtTime(oscFreq * 2, t, 0.06);
      this.v12Osc3.frequency.setTargetAtTime(oscFreq * 3, t, 0.06);

      const synthVol = throttle ? 0.35 + rpmN * 0.35 : 0.22 + (1 - rpmN) * 0.12;
      this.synthGain.gain.setTargetAtTime(synthVol, t, 0.08);
    }

    // Tunnel low-pass filter frequency drops for muffled hollow roar
    const targetCutoff = inTunnel ? 1150 : throttle ? 7500 : 1200;
    this.loadFilter.frequency.setTargetAtTime(targetCutoff, t, 0.08);
    this.loadFilter.Q.setTargetAtTime(inTunnel ? 1.8 : 0.6, t, 0.08);

    if (this.idleSrc) {
      this.idleSrc.playbackRate.setTargetAtTime(clamp(this.hz / IDLE_HZ, 0.9, 2.0), t, 0.08);
    }
  }

  setBoost(active: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.boostGain || !this.boostOsc) return;
    const t = ctx.currentTime;
    if (active) {
      this.boostGain.gain.setTargetAtTime(0.32, t, 0.04);
      this.boostOsc.frequency.setTargetAtTime(2900, t, 0.12);
    } else {
      this.boostGain.gain.setTargetAtTime(0, t, 0.12);
      this.boostOsc.frequency.setTargetAtTime(1400, t, 0.2);
    }
  }

  playNearMissWhoosh() {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf || !this.master) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(420, t);
    bp.frequency.exponentialRampToValueAtTime(1700, t + 0.09);
    bp.frequency.exponentialRampToValueAtTime(320, t + 0.26);
    bp.Q.value = 2.2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.48, t + 0.07);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.29);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t, rnd(0, 1.5), 0.3);
  }

  playCameraShutter() {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(3200, t);
    osc.frequency.exponentialRampToValueAtTime(750, t + 0.08);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);

    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  crash() {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 1.4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(5000, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 1.2);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    src.connect(lp);
    lp.connect(gain);
    gain.connect(this.master);
    src.start(t);

    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(120, t);
    thump.frequency.exponentialRampToValueAtTime(35, t + 0.35);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.9, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    thump.connect(tg);
    tg.connect(this.master);
    thump.start(t);
    thump.stop(t + 0.5);
  }
}

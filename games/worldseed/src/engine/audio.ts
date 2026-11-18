import type { Mood, WorldSpec } from '../world/spec'

/**
 * Generative soundscape built from WebAudio primitives — no audio files. A slow chord
 * pad drifts through the mood's scale, sparse bell notes fall into a delay, and wind,
 * rain and footsteps are filtered noise.
 */
const SCALES: Record<Mood, { root: number; steps: number[] }> = {
  serene: { root: 57, steps: [0, 2, 4, 7, 9, 11] },
  hopeful: { root: 60, steps: [0, 2, 4, 7, 9] },
  melancholy: { root: 57, steps: [0, 2, 3, 5, 7, 10] },
  eerie: { root: 56, steps: [0, 1, 5, 6, 10] },
  ominous: { root: 50, steps: [0, 1, 3, 6, 7, 10] },
  whimsical: { root: 62, steps: [0, 2, 4, 6, 7, 9, 11] }
}

const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12)

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private music!: GainNode
  private sfx!: GainNode
  private wind!: GainNode
  private windFilter!: BiquadFilterNode
  private rain!: GainNode
  private delay!: DelayNode
  private noise!: AudioBuffer
  private voices: { osc: OscillatorNode[]; gain: GainNode }[] = []
  private scale = SCALES.serene
  private chordTimer = 0
  private bellTimer = 3
  private degree = 0
  private volume = 0.8
  private musicVolume = 0.7
  private running = false

  get ready(): boolean {
    return !!this.ctx
  }

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined)
      return
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    const comp = ctx.createDynamicsCompressor()
    this.master.connect(comp).connect(ctx.destination)

    this.music = ctx.createGain()
    this.music.gain.value = this.musicVolume
    this.music.connect(this.master)
    this.sfx = ctx.createGain()
    this.sfx.connect(this.master)

    // A feedback delay doubles as a cheap reverb for bells.
    this.delay = ctx.createDelay(1.5)
    this.delay.delayTime.value = 0.42
    const fb = ctx.createGain()
    fb.gain.value = 0.42
    const dl = ctx.createBiquadFilter()
    dl.type = 'lowpass'
    dl.frequency.value = 2400
    this.delay.connect(dl).connect(fb).connect(this.delay)
    this.delay.connect(this.music)

    const len = ctx.sampleRate * 2
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1

    this.windFilter = ctx.createBiquadFilter()
    this.windFilter.type = 'bandpass'
    this.windFilter.frequency.value = 500
    this.windFilter.Q.value = 0.7
    this.wind = ctx.createGain()
    this.wind.gain.value = 0
    this.loopNoise().connect(this.windFilter).connect(this.wind).connect(this.master)

    const rf = ctx.createBiquadFilter()
    rf.type = 'highpass'
    rf.frequency.value = 900
    this.rain = ctx.createGain()
    this.rain.gain.value = 0
    this.loopNoise().connect(rf).connect(this.rain).connect(this.master)
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    src.start()
    return src
  }

  begin(spec: WorldSpec): void {
    if (!this.ctx) return
    this.stopMusic()
    this.scale = SCALES[spec.mood]
    const ctx = this.ctx
    const now = ctx.currentTime
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = spec.mood === 'ominous' ? 700 : 1300
    lp.connect(this.music)
    for (let v = 0; v < 4; v++) {
      const gain = ctx.createGain()
      gain.gain.value = 0
      gain.connect(lp)
      const osc = [0, 1].map((k) => {
        const o = ctx.createOscillator()
        o.type = k === 0 ? 'triangle' : 'sine'
        o.detune.value = k === 0 ? -6 : 7
        o.connect(gain)
        o.start(now)
        return o
      })
      this.voices.push({ osc, gain })
    }
    const rainy = spec.weather === 'rain' || spec.weather === 'storm'
    this.rain.gain.setTargetAtTime(rainy ? (spec.weather === 'storm' ? 0.22 : 0.12) : 0, now, 2)
    this.running = true
    this.chordTimer = 0
    this.bellTimer = 4
  }

  stopMusic(): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    for (const v of this.voices) {
      v.gain.gain.setTargetAtTime(0, now, 0.5)
      v.osc.forEach((o) => o.stop(now + 3))
    }
    this.voices = []
    this.running = false
    this.rain?.gain.setTargetAtTime(0, now, 0.5)
    this.wind?.gain.setTargetAtTime(0, now, 0.5)
  }

  private nextChord(): void {
    const ctx = this.ctx!
    const now = ctx.currentTime
    const steps = this.scale.steps
    this.degree =
      (this.degree + [2, 3, 4, 5, -2][Math.floor(Math.random() * 5)] + steps.length * 4) %
      steps.length
    const pick = [0, 2, 4, 6].map((k) => {
      const idx = this.degree + k
      return this.scale.root - 12 + steps[idx % steps.length] + 12 * Math.floor(idx / steps.length)
    })
    this.voices.forEach((v, i) => {
      const f = midi(pick[i] + (i === 0 ? -12 : 0))
      v.osc.forEach((o) => o.frequency.setTargetAtTime(f, now, 1.6))
      v.gain.gain.cancelScheduledValues(now)
      v.gain.gain.setTargetAtTime(i === 0 ? 0.05 : 0.035, now, 2.5)
    })
  }

  private bell(note: number, when = 0, gain = 0.12, dest?: AudioNode): void {
    const ctx = this.ctx!
    const t0 = ctx.currentTime + when
    const f = midi(note)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t0)
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.2)
    for (const [mult, amp] of [
      [1, 1],
      [2.76, 0.25],
      [5.4, 0.08]
    ]) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f * mult
      const og = ctx.createGain()
      og.gain.value = amp
      o.connect(og).connect(g)
      o.start(t0)
      o.stop(t0 + 3.3)
    }
    g.connect(dest ?? this.music)
    g.connect(this.delay)
  }

  private scaleNote(i: number, octave = 0): number {
    const s = this.scale.steps
    return (
      this.scale.root +
      s[((i % s.length) + s.length) % s.length] +
      12 * (octave + Math.floor(i / s.length))
    )
  }

  /** Called every frame with the player's altitude above the liquid line (0..1 normalised). */
  update(dt: number, altitude: number, windy: number): void {
    if (!this.ctx || !this.running) return
    this.chordTimer -= dt
    if (this.chordTimer <= 0) {
      this.nextChord()
      this.chordTimer = 9 + Math.random() * 7
    }
    this.bellTimer -= dt
    if (this.bellTimer <= 0) {
      this.bell(this.scaleNote(Math.floor(Math.random() * 7), 1), 0, 0.05)
      if (Math.random() < 0.4)
        this.bell(this.scaleNote(Math.floor(Math.random() * 7), 1), 0.45, 0.035)
      this.bellTimer = 3 + Math.random() * 7
    }
    const now = this.ctx.currentTime
    this.wind.gain.setTargetAtTime((0.03 + altitude * 0.12) * windy, now, 1)
    this.windFilter.frequency.setTargetAtTime(
      380 + altitude * 500 + Math.sin(now * 0.3) * 120,
      now,
      0.5
    )
  }

  private burst(
    dur: number,
    freq: number,
    q: number,
    gain: number,
    type: BiquadFilterType = 'bandpass'
  ): void {
    if (!this.ctx) return
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    const g = ctx.createGain()
    const t0 = ctx.currentTime
    g.gain.setValueAtTime(gain, t0)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    src.connect(f).connect(g).connect(this.sfx)
    src.start(t0, Math.random() * 1.5)
    src.stop(t0 + dur + 0.05)
  }

  step(surface: 'ground' | 'water'): void {
    if (surface === 'water') this.burst(0.25, 900 + Math.random() * 400, 0.8, 0.08)
    else this.burst(0.09, 250 + Math.random() * 250, 1.2, 0.12)
  }

  jump(): void {
    this.burst(0.3, 700, 0.5, 0.05)
  }

  splash(): void {
    this.burst(0.7, 1200, 0.4, 0.2)
  }

  thunder(): void {
    if (!this.ctx) return
    setTimeout(() => this.burst(3.5, 120, 0.3, 0.6, 'lowpass'), 300 + Math.random() * 1200)
  }

  blip(): void {
    if (!this.ctx) return
    this.bell(this.scaleNote(Math.floor(Math.random() * 5), 1), 0, 0.04, this.sfx)
  }

  discover(): void {
    if (!this.ctx) return
    this.bell(this.scaleNote(0, 1), 0, 0.08, this.sfx)
    this.bell(this.scaleNote(4, 1), 0.18, 0.08, this.sfx)
  }

  chime(): void {
    if (!this.ctx) return
    for (let i = 0; i < 6; i++) this.bell(this.scaleNote(i * 2, 1), i * 0.11, 0.1, this.sfx)
  }

  finale(): void {
    if (!this.ctx) return
    for (let i = 0; i < 12; i++)
      this.bell(this.scaleNote(i, i < 6 ? 0 : 1), i * 0.22, 0.09, this.sfx)
    for (let i = 0; i < 4; i++) this.bell(this.scaleNote(i * 2, -1), 2.8, 0.1, this.sfx)
  }

  setVolume(master: number, music: number): void {
    this.volume = master
    this.musicVolume = music
    if (!this.ctx) return
    this.master.gain.setTargetAtTime(master, this.ctx.currentTime, 0.1)
    this.music.gain.setTargetAtTime(music, this.ctx.currentTime, 0.1)
  }

  suspend(on: boolean): void {
    if (!this.ctx) return
    if (on) this.ctx.suspend().catch(() => undefined)
    else this.ctx.resume().catch(() => undefined)
  }
}

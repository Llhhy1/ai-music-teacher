/**
 * pipeline.js — 从 PCM 块到逐帧声学特征的分析管线
 *
 * 从 app.js 里抽出来，目的有二：
 *   1. UI 与算法解耦，浏览器和 Node 里跑的是同一份代码；
 *   2. 可以用合成信号做端到端回归测试。
 */
import { PitchDetector } from './pitch.js';
import { spectralFeatures } from './dsp.js';
import { Session } from './metrics.js';

export const HOP = 1024;
export const WIN = 2048;
const RING = WIN * 2;

export class Analyzer {
  /**
   * @param {{sampleRate:number, silenceRms?:number, eco?:boolean, toneBaseline?:number|null}} opts
   */
  constructor(opts) {
    this.sampleRate = opts.sampleRate;
    this.silenceRms = opts.silenceRms ?? 0.004;
    this.eco = !!opts.eco;
    this.toneBaseline = opts.toneBaseline ?? null;
    this.detector = new PitchDetector(this.sampleRate, {
      bufferSize: WIN,
      silenceRms: this.silenceRms,
      minFreq: 65,
      maxFreq: 1150,
    });
    this._hist = new Float32Array(RING);
    this._w = 0;
    this._total = 0;
    this._since = 0;
    this._frames = [];
    this.session = null;
    this.target = null;
    this.mode = 'free';
    this.onFrame = null;
  }

  /** 清空缓冲，准备开始一次新练习 */
  begin({ target = null, mode = 'free', toneBaseline } = {}) {
    this._hist.fill(0);
    this._w = 0;
    this._total = 0;
    this._since = 0;
    this._frames = [];
    this.target = target;
    this.mode = mode;
    this.session = new Session({
      sampleRate: this.sampleRate,
      hop: HOP,
      target,
      mode,
      toneBaseline: toneBaseline ?? this.toneBaseline,
    });
  }

  /** 结束后用本次结果刷新基线（EMA），返回新的基线值或 null */
  updateBaseline(report) {
    const cen = report?.resonance?.centroid;
    if (!Number.isFinite(cen) || cen <= 0) return this.toneBaseline;
    const prev = this.toneBaseline;
    this.toneBaseline = !Number.isFinite(prev) || prev <= 0
      ? Math.round(cen)
      : Math.round(prev * 0.7 + cen * 0.3);
    return this.toneBaseline;
  }

  push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      this._hist[this._w] = chunk[i];
      this._w = (this._w + 1) & (RING - 1);
    }
    this._total += chunk.length;
    if (!this.session) return;
    this._since += chunk.length;
    const every = (this.eco ? 4 : 2) * HOP;
    if (this._since >= every && this._total >= WIN) {
      this._since = 0;
      this._analyze();
    }
  }

  _analyze() {
    const w = new Float32Array(WIN);
    for (let i = WIN - 1; i >= 0; i--) {
      w[i] = this._hist[(this._w - WIN + i + RING) & (RING - 1)];
    }
    const t = (this._total - WIN / 2) / this.sampleRate;
    if (t < 0) return;

    const d = this.detector.process(w);
    const spec = d.silence ? { centroid: 0, hfRatio: 0 } : spectralFeatures(w, this.sampleRate);

    let targetMidi = null;
    if (this.target) {
      for (const n of this.target.notes) {
        if (t >= n.start - 0.12 && t < n.end + 0.12) { targetMidi = n.midi; break; }
      }
    }

    const frame = {
      t,
      freq: d.freq,
      midi: d.midi,
      rms: d.rms,
      hnr: d.hnr,
      centroid: spec.centroid,
      hfRatio: spec.hfRatio,
      silence: d.silence,
      targetMidi,
      deltaCents: (d.freq > 0 && targetMidi != null) ? (d.midi - targetMidi) * 100 : NaN,
    };
    this.session.addFrame(frame);
    this._frames.push(frame);
    this.onFrame?.(frame);
  }

  get frames() { return this._frames; }
  get lastT() { return this._frames.length ? this._frames[this._frames.length - 1].t : 0; }

  finalize() {
    const r = this.session ? this.session.finalize() : null;
    this.session = null;
    return r;
  }
}

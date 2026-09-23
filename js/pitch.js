/**
 * pitch.js — YIN 音高检测 + 音符换算
 *
 * YIN 算法（de Cheveigné & Kawahara, 2002）：对人声基频比自相关更稳，
 * 尤其在强谐波（元音响亮）时不容易锁到泛音上。
 */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SOLFEGE = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si'];
const JIANPU = ['1', '2', '3', '4', '5', '6', '7'];

export function freqToMidi(freq) {
  if (!freq || freq <= 0) return NaN;
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** C4 -> "C4"，六线谱/五线谱通用写法 */
export function midiToName(midi) {
  if (!Number.isFinite(midi)) return '--';
  const m = Math.round(midi);
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

/** C4 -> "do"（首调唱名，按 C 大调） */
export function midiToSolfège(midi) {
  if (!Number.isFinite(midi)) return '--';
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  if (pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10) {
    // 半音用升号前缀更直观
    const base = SOLFEGE[pc - 1] || SOLFEGE[0];
    return '#' + base;
  }
  return SOLFEGE[pc] || '--';
}

/** C4 -> "1"（简谱，以 C 为 1=C） */
export function midiToJianpu(midi) {
  if (!Number.isFinite(midi)) return '';
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  const deg = JIANPU[[0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][pc]];
  const oct = Math.floor(m / 12) - 1 - 4; // 相对中央 C 的八度
  if (pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10) return deg + '#';
  return deg + '•'.repeat(Math.max(0, oct)) ;
}

export function centsBetween(freq, targetFreq) {
  if (!freq || !targetFreq) return NaN;
  return 1200 * Math.log2(freq / targetFreq);
}

/**
 * YIN 检测器。持有可复用的临时缓冲，避免每帧 new 导致 GC 卡顿。
 */
export class PitchDetector {
  constructor(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    this.bufferSize = opts.bufferSize || 2048;
    this.minFreq = opts.minFreq || 65;
    this.maxFreq = opts.maxFreq || 1200;
    this.threshold = opts.threshold || 0.15;
    this.silenceRms = opts.silenceRms ?? 0.004;

    const tauMax = Math.min(this.bufferSize - 2, Math.floor(sampleRate / this.minFreq));
    this.tauMin = Math.max(2, Math.floor(sampleRate / this.maxFreq));
    this.tauMax = tauMax;
    this._d = new Float64Array(tauMax + 2);
    this._cmnd = new Float64Array(tauMax + 2);
  }

  /**
   * @param {Float32Array} pcm 长度必须等于 bufferSize
   * @returns {{freq:number,midi:number,clarity:number,hnr:number,rms:number,silence:boolean}}
   */
  process(pcm) {
    const N = Math.min(pcm.length, this.bufferSize);
    const sr = this.sampleRate;

    let rms = 0;
    for (let i = 0; i < N; i++) rms += pcm[i] * pcm[i];
    rms = Math.sqrt(rms / N);

    if (rms < this.silenceRms) {
      return { freq: 0, midi: NaN, clarity: 0, hnr: -99, rms, silence: true };
    }

    const d = this._d;
    const cmnd = this._cmnd;
    const tauMax = Math.min(this.tauMax, N - 2);

    // 1) 差分函数 d(τ)
    for (let tau = 1; tau <= tauMax; tau++) {
      const limit = N - tau;
      let sum = 0;
      for (let j = 0; j < limit; j++) {
        const diff = pcm[j] - pcm[j + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
    }

    // 2) 累积均值归一化 d'(τ)
    cmnd[1] = 1;
    let running = d[1];
    for (let tau = 2; tau <= tauMax; tau++) {
      running += d[tau];
      cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }

    // 3) 绝对阈值：取第一个低于阈值的 τ，并走到局部极小
    let tau = -1;
    for (let t = this.tauMin; t <= tauMax; t++) {
      if (cmnd[t] < this.threshold) {
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }

    if (tau < 0) {
      // 宽松兜底：若全局长期极小值仍够低，认为是浊音但音质差
      let best = this.tauMin;
      for (let t = this.tauMin; t <= tauMax; t++) if (cmnd[t] < cmnd[best]) best = t;
      if (cmnd[best] > 0.45) {
        return { freq: 0, midi: NaN, clarity: 1 - cmnd[best], hnr: -99, rms, silence: false };
      }
      tau = best;
    }

    // 4) 抛物线插值细化
    let betterTau = tau;
    const a = cmnd[tau - 1] ?? cmnd[tau];
    const b = cmnd[tau];
    const c = cmnd[tau + 1] ?? cmnd[tau];
    const denom = a - 2 * b + c;
    if (denom !== 0 && tau - 1 >= 1 && tau + 1 <= tauMax) {
      const shift = (a - c) / (2 * denom);
      if (Math.abs(shift) < 1) betterTau = tau + shift;
    }

    const freq = sr / betterTau;
    if (freq < this.minFreq || freq > this.maxFreq) {
      return { freq: 0, midi: NaN, clarity: 1 - b, hnr: -99, rms, silence: false };
    }

    // 5) 真实归一化自相关 -> 谐噪比 HNR（气息/漏气/沙哑的核心指标）
    const lag = Math.round(betterTau);
    const lim = N - lag;
    let num = 0, e1 = 0, e2 = 0;
    for (let j = 0; j < lim; j++) {
      const x0 = pcm[j], x1 = pcm[j + lag];
      num += x0 * x1; e1 += x0 * x0; e2 += x1 * x1;
    }
    let r = num / (Math.sqrt(e1 * e2) + 1e-12);
    if (!(r > 0)) r = 0;
    if (r > 0.9995) r = 0.9995;
    const hnr = 10 * Math.log10(r / (1 - r));

    return {
      freq,
      midi: freqToMidi(freq),
      clarity: 1 - b,
      hnr,
      rms,
      silence: false,
    };
  }
}

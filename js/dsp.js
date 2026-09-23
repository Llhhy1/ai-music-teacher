/**
 * dsp.js — 频域特征：FFT、谱质心、谱平坦度
 *
 * 谱质心（Spectral Centroid）是判断"发声位置靠前/靠后"最直接的物理量：
 *   低 → 能量堆在低频 → 闷、白嗓、位置靠后
 *   高 → 高频泛音多   → 亮、靠前、鼻音/挤
 */

export function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + (len >> 1)] * cr - im[i + k + (len >> 1)] * ci;
        const vi = re[i + k + (len >> 1)] * ci + im[i + k + (len >> 1)] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + (len >> 1)] = ur - vr; im[i + k + (len >> 1)] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const hannCache = new Map();
function hann(n) {
  if (!hannCache.has(n)) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return hannCache.get(n);
}

/**
 * 计算一帧的频域特征。
 *
 * centroid 用**功率加权**并限制在 100–6000 Hz：
 *   - 幅度加权时，宽带底噪（能量摊在 0–22k）会把质心拉到 5000Hz 以上，完全失真；
 *     平方后噪声占比从 ~15% 降到 <1%，标定脚本实测漏气噪声只造成 0.8% 漂移。
 *   - 标定（test/calibrate.mjs，源-滤波器合成典型元音）显示该定义下
 *     常见元音落在 200–600 Hz，且**主要随元音变化、几乎不随谱倾斜变化**——
 *     因此它是"音色明暗"的客观测量，不能单独用来判断发声位置好坏，
 *     应与本人历史基线比较才有意义。
 *
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @returns {{centroid:number, flatness:number, rolloff:number, hfRatio:number}}
 */
export function spectralFeatures(pcm, sampleRate) {
  const n = 2048;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const w = hann(pcm.length);
  const start = Math.max(0, pcm.length - n);
  for (let i = 0; i < pcm.length && i < n; i++) re[i] = pcm[start + i] * w[i];
  fftRadix2(re, im);

  const bins = n >> 1;
  const binHz = sampleRate / n;
  const loBin = Math.max(1, Math.round(100 / binHz));
  const hiBin = Math.min(bins - 1, Math.round(6000 / binHz));

  let num = 0, den = 0, logSum = 0, cnt = 0;
  let total = 0, hf = 0;
  const hfBin = Math.min(bins - 1, Math.round(8000 / binHz));

  for (let i = 1; i < bins; i++) {
    const re2 = re[i], im2 = im[i];
    const p = re2 * re2 + im2 * im2;      // 功率
    total += p;
    if (i >= loBin && i <= hiBin) {
      num += (i * binHz) * p;
      den += p;
    }
    const m = Math.sqrt(p);
    if (m > 1e-10) { logSum += Math.log(m); cnt++; } else logSum += Math.log(1e-10);
    if (i >= hfBin) hf += p;
  }

  // 90% 能量 rolloff（全带，功率加权）
  let rolloff = 0, acc = 0;
  for (let i = 1; i < bins; i++) {
    const re2 = re[i], im2 = im[i];
    acc += re2 * re2 + im2 * im2;
    if (acc >= total * 0.9) { rolloff = i * binHz; break; }
  }

  return {
    centroid: den > 0 ? num / den : 0,
    flatness: cnt > 0 && total > 0 ? Math.exp(logSum / cnt) / (Math.sqrt(total) / cnt) : 0,
    rolloff,
    hfRatio: total > 0 ? hf / total : 0,
  };
}

/** 分贝换算 */
export function rmsToDb(rms) {
  return 20 * Math.log10(Math.max(rms, 1e-6));
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function median(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(arr, p) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const idx = clamp(Math.round((s.length - 1) * p), 0, s.length - 1);
  return s[idx];
}

export function mean(arr) {
  if (!arr.length) return NaN;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

export function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) * (v - m);
  return Math.sqrt(s / (arr.length - 1));
}

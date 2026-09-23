/**
 * calibrate.mjs — 用源-滤波器（formant）合成器标定"发声位置"指标
 *
 * 1/h^1.25 的谐波列只是近似，真实元音的频谱由共振峰包络决定。
 * 这里合成几个典型元音 + 漏气噪声，比较几种谱质心定义的区分度和抗噪性，
 * 据此确定 metrics.js 里的算法与阈值。跑完即可删除，结果记录在 README。
 */
import { spectralFeatures, fftRadix2 } from '../js/dsp.js';

const SR = 44100;

/** 二阶谐振器（共振峰） */
function resonator(x, formants) {
  // formants: [{f, bw}]
  let out = x;
  for (const { f, bw } of formants) {
    const r = Math.exp(-Math.PI * bw / SR);
    const theta = 2 * Math.PI * f / SR;
    const a1 = 2 * r * Math.cos(theta);
    const a2 = -r * r;
    const g = (1 - r) * Math.sqrt(1 - 2 * r * Math.cos(2 * theta) + r * r); // 归一化增益
    const y = new Float64Array(out.length);
    let y1 = 0, y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const v = g * out[i] + a1 * y1 + a2 * y2;
      y[i] = v;
      y2 = y1; y1 = v;
    }
    out = y;
  }
  return out;
}

/** 声门脉冲串 + 频谱倾斜 */
function glottal(f0, n, breathiness = 0, tiltHz = 3500) {
  const buf = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const prev = phase;
    phase += f0 / SR;
    if (phase >= 1) phase -= 1;
    // Rosenberg 脉冲近似
    const p = prev < 0.56 ? (1 - Math.pow(2 * prev / 0.56 - 1, 2)) / 2 : 0;
    buf[i] = p;
    if (breathiness) buf[i] += (Math.random() * 2 - 1) * breathiness;
  }
  // 谱倾斜：一阶低通（-6dB/oct），转折点越高越"亮"
  let a = 0;
  const out = new Float64Array(n);
  const k = Math.exp(-2 * Math.PI * tiltHz / SR);
  for (let i = 0; i < n; i++) { a = (1 - k) * buf[i] + k * a; out[i] = a; }
  return out;
}

/** 典型元音共振峰 (Hz, 带宽) */
const VOWELS = {
  '啊 a（开口、靠后→白嗓易发闷）': [{ f: 700, bw: 90 }, { f: 1100, bw: 110 }, { f: 2500, bw: 160 }],
  '呜 u（能量最集中低频）': [{ f: 320, bw: 60 }, { f: 700, bw: 90 }, { f: 2300, bw: 160 }],
  '衣 i（高频丰富、靠前）': [{ f: 300, bw: 60 }, { f: 2300, bw: 130 }, { f: 3000, bw: 180 }],
  '诶 e（居中）': [{ f: 500, bw: 70 }, { f: 1700, bw: 120 }, { f: 2700, bw: 170 }],
  '哦 o（偏暗）': [{ f: 500, bw: 70 }, { f: 900, bw: 100 }, { f: 2400, bw: 160 }],
};

/** 两种谱质心定义 */
function centroidVariant(pcm, lo, hi, power) {
  const N = 4096;
  const re = new Float64Array(N), im = new Float64Array(N);
  const w = Math.min(pcm.length, N);
  for (let i = 0; i < w; i++) {
    re[i] = pcm[pcm.length - w + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (w - 1)));
  }
  // 复用 dsp 里的 FFT
  fftRadix2(re, im);
  const bin = SR / N;
  let num = 0, den = 0;
  for (let i = 1; i < N / 2; i++) {
    const f = i * bin;
    if (f < lo || f > hi) continue;
    const m2 = re[i] * re[i] + im[i] * im[i];
    const m = power ? m2 : Math.sqrt(m2);
    num += f * m; den += m;
  }
  return den > 0 ? num / den : 0;
}

console.log('元音'.padEnd(34), '幅度质心(100-6k)'.padEnd(18), '功率质心(100-6k)'.padEnd(18), '漏气后功率质心');
console.log('-'.repeat(96));

const results = {};
for (const [name, F] of Object.entries(VOWELS)) {
  const src = glottal(220, SR * 2);
  const clean = resonator(src, F);
  const breathy = resonator(glottal(220, SR * 2, 0.05), F);

  const mag = centroidVariant(clean, 100, 6000, false);
  const pow = centroidVariant(clean, 100, 6000, true);
  const powB = centroidVariant(breathy, 100, 6000, true);

  results[name] = { mag, pow, powB };
  console.log(name.padEnd(30), String(Math.round(mag)).padEnd(20), String(Math.round(pow)).padEnd(20), Math.round(powB));
}

// 不同谱倾斜（气声/结实）对指标的影响 —— 这才是"位置"要抓的差异
console.log('\n谱倾斜(低通转折)对同一元音 /a/ 的影响 —— 这才是"位置/结实度"的可测信号:');
console.log('转折点'.padEnd(14), '幅度质心(100-6k)'.padEnd(20), '功率质心(100-6k)'.padEnd(20), '说明');
console.log('-'.repeat(84));
for (const [hz, desc] of [[800, '极暗 / 白嗓、能量堆低频'], [1800, '偏暗'], [3500, '正常'], [8000, '亮 / 靠前'], [20000, '极亮 / 可能挤']]) {
  const s = resonator(glottal(220, SR * 2, 0, hz), VOWELS['啊 a（开口、靠后→白嗓易发闷）']);
  const m = centroidVariant(s, 100, 6000, false);
  const p = centroidVariant(s, 100, 6000, true);
  console.log(String(hz + 'Hz').padEnd(12), String(Math.round(m)).padEnd(22), String(Math.round(p)).padEnd(22), desc);
}
const pows = Object.values(results).map(r => r.pow);
const mags = Object.values(results).map(r => r.mag);
console.log('\n功率质心(100-6k) 范围:', Math.round(Math.min(...pows)), '~', Math.round(Math.max(...pows)), 'Hz');
console.log('幅度质心(100-6k) 范围:', Math.round(Math.min(...mags)), '~', Math.round(Math.max(...mags)), 'Hz');

// 漏气对两种定义的干扰幅度
const deltas = Object.values(results).map(r => Math.abs(r.powB - r.pow) / r.pow);
console.log('漏气(0.05) 造成的功率质心相对漂移: 平均',
  (deltas.reduce((a, b) => a + b, 0) / deltas.length * 100).toFixed(1) + '%, 最大',
  (Math.max(...deltas) * 100).toFixed(1) + '%');

// 与项目当前实现（dsp.spectralFeatures，幅度、全带）对比
console.log('\n项目当前实现（幅度加权、全带 0-22k）:');
for (const [name, F] of Object.entries(VOWELS)) {
  const clean = resonator(glottal(220, SR * 2), F);
  const f = spectralFeatures(Float32Array.from(clean.slice(SR, SR + 2048)), SR);
  const fb = spectralFeatures(Float32Array.from(resonator(glottal(220, SR * 2, 0.05), F).slice(SR, SR + 2048)), SR);
  console.log('  ' + name.padEnd(30), '干净=' + Math.round(f.centroid) + 'Hz', ' 漏气=' + Math.round(fb.centroid) + 'Hz');
}

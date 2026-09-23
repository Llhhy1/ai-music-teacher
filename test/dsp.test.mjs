/**
 * test/dsp.test.mjs — 用合成信号验证音高/频谱检测的正确性
 * 运行：npm test
 */
import { PitchDetector, freqToMidi, midiToFreq, midiToName } from '../js/pitch.js';
import { spectralFeatures, median, stddev } from '../js/dsp.js';

const SR = 44100;
const BUF = 2048;
let pass = 0, fail = 0;

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name} ${detail}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

function makeTone(freq, { harmonics = 1, noise = 0, len = BUF * 4, detuneCents = 0 } = {}) {
  const f = freq * Math.pow(2, detuneCents / 1200);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += (1 / h) * Math.sin(2 * Math.PI * f * h * t);
    v /= harmonics === 1 ? 1 : Math.log(harmonics) + 1;
    if (noise) v += (Math.random() * 2 - 1) * noise;
    buf[i] = v * 0.4;
  }
  return buf;
}

function detectAll(buf) {
  const det = new PitchDetector(SR, { bufferSize: BUF });
  const out = [];
  for (let off = 0; off + BUF <= buf.length; off += 1024) {
    out.push(det.process(buf.subarray(off, off + BUF)));
  }
  return out;
}

console.log('\n[1] 基础换算');
ok('A4=440Hz -> midi 69', Math.abs(freqToMidi(440) - 69) < 1e-9);
ok('midi 69 -> 440Hz', Math.abs(midiToFreq(69) - 440) < 1e-9);
ok('midi 60 -> C4', midiToName(60) === 'C4', midiToName(60));
ok('midi 69 -> A4', midiToName(69) === 'A4', midiToName(69));
ok('midi 57 -> A3', midiToName(57) === 'A3', midiToName(57));

console.log('\n[2] 纯音基频检测');
for (const f of [110, 146.83, 220, 261.63, 329.63, 440, 523.25, 880]) {
  const buf = makeTone(f, { harmonics: 1 });
  const res = detectAll(buf).filter(r => r.freq > 0);
  const err = median(res.map(r => Math.abs(r.freq - f) / f * 100));
  ok(`${f}Hz 误差 <0.5%`, err < 0.5, `err=${err.toFixed(3)}% n=${res.length}`);
}

console.log('\n[3] 强谐波人声近似（避免锁到泛音/八度错误）');
for (const f of [130.81, 196, 246.94, 392]) {
  const buf = makeTone(f, { harmonics: 8 });
  const res = detectAll(buf).filter(r => r.freq > 0);
  const err = median(res.map(r => Math.abs(r.freq - f) / f * 100));
  ok(`${f}Hz 多谐波 误差 <1%`, err < 1, `err=${err.toFixed(3)}%`);
}

console.log('\n[4] 音分偏差（发音诊断的精度门槛）');
for (const cents of [-50, -30, -12, 0, 12, 30, 50]) {
  const buf = makeTone(440, { harmonics: 6, detuneCents: cents });
  const res = detectAll(buf).filter(r => r.freq > 0);
  const est = median(res.map(r => 1200 * Math.log2(r.freq / 440)));
  ok(`应为 ${cents > 0 ? '+' : ''}${cents} 音分`, Math.abs(est - cents) < 6, `实测 ${est.toFixed(1)}`);
}

console.log('\n[5] 加噪鲁棒性（真实环境会有底噪）');
for (const noise of [0.01, 0.03, 0.06]) {
  const buf = makeTone(329.63, { harmonics: 6, noise });
  const res = detectAll(buf).filter(r => r.freq > 0);
  const ratio = res.length / Math.floor((buf.length - BUF) / 1024 + 1);
  const err = res.length ? median(res.map(r => Math.abs(r.freq - 329.63) / 329.63 * 100)) : 999;
  ok(`噪声 ${noise} 检出率>70% 且误差<1.5%`, ratio > 0.7 && err < 1.5,
     `检出 ${(ratio * 100).toFixed(0)}% err=${err.toFixed(2)}%`);
}

console.log('\n[6] 静音不误报');
{
  const buf = new Float32Array(BUF * 6);
  const res = detectAll(buf);
  ok('静音全部判为 silence', res.every(r => r.silence), `n=${res.length}`);
}

console.log('\n[7] HNR 谐噪比：纯净音 vs 漏气音');
{
  const pure = detectAll(makeTone(220, { harmonics: 8, noise: 0.002 }));
  const breathy = detectAll(makeTone(220, { harmonics: 3, noise: 0.12 }));
  const hp = median(pure.filter(r => r.freq > 0).map(r => r.hnr));
  const hb = median(breathy.filter(r => r.freq > 0).map(r => r.hnr));
  ok('纯净音 HNR > 漏气音 HNR 至少 6dB', hp - hb > 6, `纯净=${hp.toFixed(1)}dB 漏气=${hb.toFixed(1)}dB`);
}

console.log('\n[8] 谱质心：闷（低频集中）vs 亮（高频集中）');
{
  const dark = makeTone(180, { harmonics: 3 });
  const bright = makeTone(180, { harmonics: 20 });
  const cd = spectralFeatures(dark.subarray(0, 2048), SR).centroid;
  const cb = spectralFeatures(bright.subarray(0, 2048), SR).centroid;
  ok('亮音谱质心明显更高', cb > cd * 1.5, `闷=${cd.toFixed(0)}Hz 亮=${cb.toFixed(0)}Hz`);
}

console.log('\n[9] 颤音检测用的 f0 曲线稳定性');
{
  const steady = makeTone(330, { harmonics: 6, len: SR });
  const res = detectAll(steady).filter(r => r.freq > 0);
  const cents = res.map(r => 1200 * Math.log2(r.freq / 330));
  ok('稳态音音分标准差 <3', stddev(cents) < 3, `σ=${stddev(cents).toFixed(2)}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);

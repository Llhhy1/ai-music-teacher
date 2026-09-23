/**
 * demo.js — 演示音源
 *
 * 不依赖麦克风，合成一段"典型的初学者演唱"（故意掺入跑调、抢拍、漏气、
 * 长音不稳），走和真实录音完全相同的分析管线。
 * 用途：1) 用户没给麦克风权限时也能看懂产品 2) 端到端回归验证。
 *
 * 注意：变频合成必须用**相位累加器**（phase += 2πf/fs）。
 * 用 sin(2π·f(t)·t) 会让瞬时频率多出 t·df/dt 项，t 越大偏得越多。
 */
import { midiToFreq } from './pitch.js';

const SR = 44100;
const TWO_PI = Math.PI * 2;

/**
 * 自由清唱模式的演示音源时间轴：一段五声即兴，没有目标音高。
 * @returns {{notes:Array,duration:number}}
 */
export function buildImprov() {
  const line = [
    [60, 1], [62, 1], [64, 1.5], [67, 1], [69, 2],
    [67, 1], [64, 1], [62, 1.5], [60, 2], [null, 1],
    [64, 1], [67, 1], [72, 2], [69, 1], [67, 1.5],
    [64, 1], [62, 1], [60, 3],
  ];
  let t = 1.0;
  const notes = [];
  line.forEach(([m, b]) => {
    const start = t;
    const end = start + b * 0.55;
    t = end;
    if (m != null) notes.push({ index: notes.length, midi: m, start, end, beats: b, lyric: '' });
  });
  return { notes, duration: t + 0.8 };
}

export class DemoSource {
  /**
   * @param {{notes:Array,duration:number}} timeline
   * @param {(chunk:Float32Array)=>void} onChunk
   */
  constructor(timeline, onChunk) {
    this.timeline = timeline;
    this.onChunk = onChunk;
    this.pos = 0;          // 全局采样位置
    this.phase = 0;        // 相位累加器
    this.timer = null;
    this.stopped = false;

    // 给每个音一个固定的"学生失误画像"，保证演示结果稳定可复现
    this.errors = timeline.notes.map((n, i) => ({
      cents: [-38, 14, 52, -21, 9, 66, -47, 25, -12, 41][i % 10],            // 音准偏差
      delay: [-0.12, 0.18, -0.05, 0.26, 0.09, -0.16, 0.22, 0.04][i % 8],     // 进拍延迟(s)
      wobble: 6 + ((i * 7) % 20),                                            // 长音游移（音分）
      breath: 0.030 + ((i * 3) % 7) * 0.010,                                 // 漏气噪声强度
    }));
  }

  start() {
    const tick = () => {
      if (this.stopped) return;
      const chunk = this.render(1024);
      if (chunk === null) { this.stop(); return; }   // 演示音源播放完毕
      this.onChunk(chunk);
      this.timer = setTimeout(tick, (1024 / SR) * 1000);
    };
    tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** 渲染 1024 个样本；超过时间轴末端返回 null */
  render(n) {
    const out = new Float32Array(n);
    const t0 = this.pos / SR;
    const T = this.timeline;
    if (t0 > T.duration + 0.3) return null;

    for (let i = 0; i < n; i++) {
      const t = t0 + i / SR;
      let f = 0, env = 0, breath = 0;

      for (let k = 0; k < T.notes.length; k++) {
        const note = T.notes[k];
        const err = this.errors[k];
        const start = note.start + err.delay;
        const end = note.end + err.delay;
        if (t < start || t > end) continue;

        const dur = end - start;
        const prog = (t - start) / dur;

        // 起音包络：25ms 上升，收尾 60ms 下落
        env = 1;
        if (t - start < 0.025) env = (t - start) / 0.025;
        if (end - t < 0.06) env = Math.min(env, (end - t) / 0.06);

        // 目标音 + 音准偏差 + 句中滑动 + 长音颤动
        let cents = err.cents;
        cents += (prog - 0.5) * 18;
        cents += Math.sin(TWO_PI * 5.2 * t) * err.wobble * (dur > 1.2 ? 1 : 0.35);
        cents += Math.sin(TWO_PI * 0.7 * t) * 7;

        f = midiToFreq(note.midi) * Math.pow(2, cents / 1200);
        breath = err.breath;
        break;   // 音符在时间上不重叠，命中即止
      }

      let v = 0;
      if (f > 0) {
        // ✅ 相位累加：瞬时频率严格等于 f，与 t 无关
        this.phase += (TWO_PI * f) / SR;
        if (this.phase > TWO_PI) this.phase -= TWO_PI;

        let s = 0;
        for (let h = 1; h <= 9; h++) s += (1 / Math.pow(h, 1.25)) * Math.sin(this.phase * h);
        s /= 2.4;

        const noise = (Math.random() * 2 - 1) * breath;   // 漏气：宽带噪声
        v = (s + noise) * env * 0.45;
      }

      v += (Math.random() * 2 - 1) * 0.0025;              // 房间底噪
      out[i] = Math.max(-1, Math.min(1, v));
    }

    this.pos += n;
    return out;
  }
}

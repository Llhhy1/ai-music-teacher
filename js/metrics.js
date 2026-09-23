/**
 * metrics.js — 演唱分析引擎
 *
 * 把逐帧的声学特征（音高/响度/谐噪比/谱质心）汇总成一份"老师听得出来"的诊断报告。
 * 输入由 app.js 提供（真实麦克风）或 demo 模式合成，因此本模块完全可离线复现。
 */
import { midiToName, midiToSolfège } from './pitch.js';
import { median, percentile, mean, stddev, clamp, rmsToDb } from './dsp.js';

const SEG_MIN_LEN = 3;      // 至少 3 帧才算一个持续音
const SUSTAIN_FRAMES = 6;   // ≥6 帧（约 0.3s）才算"稳住的长音"
const SEGMENT_JUMP_SEMI = 2.5;

export class Session {
  /**
   * @param {{sampleRate:number, hop:number, target?:object, mode:string, toneBaseline?:number|null}} opts
   *   target      = { notes:[{midi,start,end,lyric}], duration }
   *   mode        = 'melody' | 'free' | 'range'
   *   toneBaseline= 本人历史音色明暗中位数（Hz），用于"位置是否掉了"的自比较
   */
  constructor(opts) {
    this.sampleRate = opts.sampleRate;
    this.hop = opts.hop;
    this.target = opts.target || null;
    this.mode = opts.mode || 'free';
    this.toneBaseline = opts.toneBaseline ?? null;
    this.frames = [];
    this.startedAt = performance.now();
  }

  addFrame(f) { this.frames.push(f); }

  get duration() {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }

  /** 把连续帧切成"音符段"：静音断开、音高跳变 >2.5 半音断开 */
  _segments() {
    const segs = [];
    let cur = null;
    let lastMidi = null;
    for (const f of this.frames) {
      const voiced = f.freq > 0 && !f.silence;
      const breakSeg = !cur
        ? false
        : (!voiced || (lastMidi != null && Number.isFinite(f.midi) && Math.abs(f.midi - lastMidi) > SEGMENT_JUMP_SEMI));
      if (!cur || breakSeg) {
        if (cur && cur.frames.length >= SEG_MIN_LEN) segs.push(cur);
        cur = voiced ? { frames: [], start: f.t, end: f.t } : null;
        lastMidi = null;
      }
      if (cur && voiced) {
        cur.frames.push(f);
        cur.end = f.t;
        lastMidi = f.midi;
      }
    }
    if (cur && cur.frames.length >= SEG_MIN_LEN) segs.push(cur);
    return segs.map((s, i) => ({
      id: i,
      start: s.start,
      end: s.end,
      midi: median(s.frames.map(f => f.midi)),
      frames: s.frames,
      len: s.end - s.start,
    }));
  }

  /** 时间 t 上的目标音高（跟唱模式） */
  _targetAt(t) {
    if (!this.target) return null;
    for (const n of this.target.notes) {
      // 容忍前后各 120ms 的进拍误差
      if (t >= n.start - 0.12 && t < n.end + 0.12) return n;
    }
    return null;
  }

  finalize() {
    const F = this.frames;
    const voiced = F.filter(f => f.freq > 0 && !f.silence);
    const segs = this._segments();

    // ---------- 音域 ----------
    const sustained = segs.filter(s => s.frames.length >= SUSTAIN_FRAMES);
    const rangeSource = sustained.length ? sustained : segs;
    const lowMidi = rangeSource.length ? Math.min(...rangeSource.map(s => s.midi)) : NaN;
    const highMidi = rangeSource.length ? Math.max(...rangeSource.map(s => s.midi)) : NaN;
    const range = {
      lowMidi, highMidi,
      low: midiToName(lowMidi), high: midiToName(highMidi),
      lowSol: midiToSolfège(lowMidi), highSol: midiToSolfège(highMidi),
      span: Number.isFinite(lowMidi) ? highMidi - lowMidi : 0,
    };

    // ---------- 音准 ----------
    let pitch;
    if (this.target && voiced.length) {
      const diffs = [];
      const perNote = new Map();
      for (const f of voiced) {
        const n = this._targetAt(f.t);
        if (!n) continue;
        const d = (f.midi - n.midi) * 100;
        diffs.push(d);
        if (!perNote.has(n.index)) perNote.set(n.index, []);
        perNote.get(n.index).push(d);
      }
      const abs = diffs.map(Math.abs);
      pitch = {
        compared: diffs.length,
        meanAbsCents: abs.length ? mean(abs) : NaN,
        biasCents: diffs.length ? mean(diffs) : 0,
        accuracy50: abs.length ? abs.filter(v => v <= 50).length / abs.length : 0,
        accuracy25: abs.length ? abs.filter(v => v <= 25).length / abs.length : 0,
        noteScores: [...perNote.entries()].map(([idx, ds]) => {
          const n = this.target.notes.find(x => x.index === idx);
          return {
            index: idx,
            target: n ? n.midi : NaN,
            lyric: n ? n.lyric : '',
            err: mean(ds.map(Math.abs)),
            bias: mean(ds),
          };
        }),
      };
    } else {
      pitch = { compared: 0, meanAbsCents: NaN, biasCents: 0, accuracy50: 0, accuracy25: 0, noteScores: [] };
    }

    // ---------- 稳定性（长音内的音高游移）----------
    const stabSamples = sustained.map(s => stddev(s.frames.map(f => (f.midi - s.midi) * 100)));
    const stabilityCents = stabSamples.length ? median(stabSamples) : NaN;

    // ---------- 颤音 ----------
    const vibrato = detectVibrato(sustained);

    // ---------- 气息 / 共鸣 / 动态 ----------
    const hnrVals = voiced.map(f => f.hnr).filter(v => v > -50);
    const centVals = voiced.map(f => f.centroid).filter(v => v > 0);
    const hfVals = voiced.map(f => f.hfRatio).filter(v => v >= 0);
    const rmsVals = voiced.map(f => f.rms);
    const breath = {
      hnr: hnrVals.length ? median(hnrVals) : NaN,
      hfRatio: hfVals.length ? median(hfVals) : NaN,
    };
    const resonance = { centroid: centVals.length ? median(centVals) : NaN };
    let dynamics = { rangeDb: NaN };
    if (rmsVals.length > 8) {
      dynamics.rangeDb = rmsToDb(percentile(rmsVals, 0.9)) - rmsToDb(percentile(rmsVals, 0.1));
    }

    // ---------- 节奏（起唱时机）----------
    const timing = this.target ? this._timing(segs) : { medianDelayMs: NaN, matched: 0, anticipations: 0 };

    // ---------- 打分 ----------
    const scores = computeScores({ pitch, stabilityCents, breath, resonance, timing, dynamics, vibrato, mode: this.mode, toneBaseline: this.toneBaseline });

    // ---------- 结论文本 ----------
    const findings = buildFindings({ pitch, stabilityCents, breath, resonance, timing, dynamics, vibrato, range, scores, mode: this.mode, toneBaseline: this.toneBaseline });

    return {
      mode: this.mode,
      duration: this.duration,
      frames: F.length,
      voicedFrames: voiced.length,
      voicedRatio: F.length ? voiced.length / F.length : 0,
      segments: segs.length,
      range,
      pitch,
      stabilityCents,
      vibrato,
      breath,
      resonance,
      dynamics,
      timing,
      scores,
      findings,
      series: F.map(f => ({
        t: f.t,
        midi: f.freq > 0 && !f.silence ? f.midi : null,
        cents: Number.isFinite(f.deltaCents) ? f.deltaCents : null,
        rms: f.rms,
        hnr: f.hnr,
        centroid: f.centroid,
        target: f.targetMidi ?? null,
      })),
      noteErr: pitch.noteScores,
    };
  }

  _timing(segs) {
    const used = new Set();
    const delays = [];
    let anticipations = 0;
    for (const n of this.target.notes) {
      // 在 [前一音结束, 本音开始+0.7s] 内找第一个起唱点
      const winStart = n.start - 0.18;
      const winEnd = n.start + 0.7;
      let best = null;
      for (const s of segs) {
        if (used.has(s.id)) continue;
        if (s.start >= winStart && s.start <= winEnd) {
          if (!best || s.start < best.start) best = s;
        }
      }
      if (best) {
        used.add(best.id);
        const d = (best.start - n.start) * 1000;
        delays.push(d);
        if (d < -60) anticipations++;
      }
    }
    return {
      medianDelayMs: delays.length ? median(delays) : NaN,
      matched: delays.length,
      anticipations,
      total: this.target.notes.length,
    };
  }
}

function detectVibrato(segments) {
  // 只用 ≥0.8s 的长音，太短测不出周期
  const cands = segments
    .filter(s => s.len >= 0.8 && s.frames.length >= 10)
    .map(s => s.frames.map(f => (f.midi - s.midi) * 100));
  if (!cands.length) return { present: false, rate: 0, extent: 0 };

  // 取最"像颤音"的一段
  let best = null;
  for (const cents of cands) {
    // 去线性趋势
    const n = cents.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += cents[i]; sxy += i * cents[i]; sxx += i * i; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
    const intercept = (sy - slope * sx) / n;
    const det = cents.map((v, i) => v - (slope * i + intercept));

    let crossings = 0;
    for (let i = 1; i < n; i++) if ((det[i - 1] < 0) !== (det[i] < 0)) crossings++;
    const dur = (n - 1) * 0.07; // 帧间隔约 70ms
    const rate = dur > 0 ? crossings / 2 / dur : 0;
    const extent = (percentile(det, 0.95) - percentile(det, 0.05)) / 2;
    const cand = { rate, extent };
    if (!best || extent > best.extent) best = cand;
  }

  const musical = best.rate >= 4 && best.rate <= 7.5 && best.extent >= 18;
  const wild = best.rate > 8.5 || best.extent > 130;
  return {
    present: best.extent >= 18 && best.rate >= 2.5,
    musical,
    wild,
    rate: Number(best.rate.toFixed(1)),
    extent: Math.round(best.extent),
  };
}

function computeScores(r) {
  const c = v => clamp(v, 0, 100);
  const { pitch, stabilityCents, breath, resonance, timing, dynamics } = r;

  // 音准
  let pitchScore;
  if (r.mode === 'melody' && Number.isFinite(pitch.meanAbsCents)) {
    pitchScore = c(100 - pitch.meanAbsCents * 1.15);
  } else if (Number.isFinite(stabilityCents)) {
    pitchScore = c(100 - stabilityCents * 1.8);
  } else {
    pitchScore = 50;
  }

  // 节奏
  let rhythmScore = null;
  if (Number.isFinite(timing.medianDelayMs)) {
    rhythmScore = c(100 - Math.abs(timing.medianDelayMs) * 0.28);
  }

  // 气息：HNR 是漏气/结实程度的直接量化
  const hnr = breath.hnr;
  const breathScore = Number.isFinite(hnr) ? c((hnr - 3) * 5.2) : 50;

  // 稳定性
  const stabScore = Number.isFinite(stabilityCents)
    ? c(100 - stabilityCents * 2.0)
    : 50;

  // 音色明暗：绝对谱质心主要由元音决定（标定实测 263→548Hz），不能横比好坏；
  // 只有拿到本人基线才做"相对自己变暗/变亮"的比较，否则不计入总分。
  const cen = resonance.centroid;
  let resonanceScore = null;
  if (Number.isFinite(cen) && cen > 0 && Number.isFinite(r.toneBaseline) && r.toneBaseline > 0) {
    resonanceScore = c(100 - Math.abs(Math.log2(cen / r.toneBaseline)) * 80);
  }

  const parts = [pitchScore, breathScore, stabScore];
  if (resonanceScore != null) parts.push(resonanceScore);
  if (rhythmScore != null) parts.push(rhythmScore);
  const overall = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);

  return {
    pitch: Math.round(pitchScore),
    rhythm: rhythmScore == null ? null : Math.round(rhythmScore),
    breath: Math.round(breathScore),
    stability: Math.round(stabScore),
    resonance: resonanceScore == null ? null : Math.round(resonanceScore),
    overall,
  };
}

function buildFindings(r) {
  const out = [];
  const { pitch, stabilityCents, breath, resonance, timing, dynamics, vibrato, range, scores, mode } = r;
  const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '--');

  // 音准
  if (mode === 'melody' && Number.isFinite(pitch.meanAbsCents)) {
    const e = pitch.meanAbsCents;
    const dir = pitch.biasCents > 8 ? '整体偏高' : pitch.biasCents < -8 ? '整体偏低' : '没有系统性偏移';
    if (e <= 15) out.push({ key: 'pitch', level: 'good', title: '音准扎实', text: `平均音高偏差 ${num(e)} 音分，达到专业录音棚可接受线（15 音分内），${dir}。` });
    else if (e <= 35) out.push({ key: 'pitch', level: 'warn', title: '音准基本在线', text: `平均偏差 ${num(e)} 音分，${dir}。听感上会有一点点"没咬住"，重点盯住偏差最大的那几个音。` });
    else out.push({ key: 'pitch', level: 'bad', title: '跑调明显', text: `平均偏差 ${num(e)} 音分（${dir}），已超过半音的一半。先降速 50% 单音模唱，别急着跟原速。` });

    if (pitch.noteScores.length) {
      const worst = [...pitch.noteScores].sort((a, b) => b.err - a.err).slice(0, 3);
      out.push({
        key: 'pitch-worst', level: 'warn', title: '最需要单独练的音',
        text: worst.map(w => {
          const tag = w.lyric ? `「${w.lyric}」` : `第 ${w.index + 1} 个音（${midiToName(w.target)}）`;
          const bias = w.bias > 15 ? '，偏高' : w.bias < -15 ? '，偏低' : '';
          return `${tag} 偏差 ${num(w.err)} 音分${bias}`;
        }).join('；') + '。',
      });
    }
  } else if (Number.isFinite(stabilityCents)) {
    if (stabilityCents <= 12) out.push({ key: 'stability', level: 'good', title: '音高很稳', text: `长音内音高游移仅 ${num(stabilityCents)} 音分，听感是"立得住"的声音。` });
    else if (stabilityCents <= 25) out.push({ key: 'stability', level: 'warn', title: '音高略有游移', text: `长音内波动 ${num(stabilityCents)} 音分，属于初学者正常范围，靠气息支撑可以压到 10 音分内。` });
    else out.push({ key: 'stability', level: 'bad', title: '音高晃动大', text: `长音内波动高达 ${num(stabilityCents)} 音分，多半是气息不匀 + 喉部代偿，先练"嘶"长音稳定住再上旋律。` });
  }

  // 气息
  const hnr = breath.hnr;
  if (Number.isFinite(hnr)) {
    if (hnr >= 19) out.push({ key: 'breath', level: 'good', title: '发声结实', text: `谐噪比 ${num(hnr)} dB，声带闭合良好，没有明显漏气。` });
    else if (hnr >= 12) out.push({ key: 'breath', level: 'warn', title: '轻微漏气', text: `谐噪比 ${num(hnr)} dB，声音里掺了气声，"字头"不够干净。每天 5 分钟"嘶——"长音 + 短促"嘿"起音能改善。` });
    else out.push({ key: 'breath', level: 'bad', title: '漏气明显', text: `谐噪比只有 ${num(hnr)} dB，气流大部分没变成声音。这是最容易被视频课忽略的问题，优先练闭合：短促"啊-啊-啊"连续弹发，感觉腹部弹一下。` });
  }

  // 音色明暗（发声位置的可量化代理）
  // 标定结论：功率加权 + 100–6000Hz 带限后，常见元音落在 200–600Hz；
  // 元音本身能把质心搬动 263→548Hz，远大于"位置好坏"造成的差异，
  // 所以绝对值只作参考，只有和本人基线比才有意义。
  const cen = resonance.centroid;
  const base = r.toneBaseline;
  if (Number.isFinite(cen) && cen > 0) {
    const ratio = Number.isFinite(base) && base > 0 ? cen / base : null;
    const ref = `本次功率谱质心 ${Math.round(cen)}Hz（同类元音常见 200–600Hz；这个绝对值主要由你唱的元音决定，不能跨元音比大小）`;
    if (ratio == null) {
      out.push({ key: 'resonance', level: 'info', title: '音色明暗（暂无个人基线）', text: `${ref}。多录几次建立基线后，才能判断你相对自己是变闷还是变亮。在此之前想改善听感，练"哼鸣带进开口唱"总是安全的。` });
    } else if (ratio < 0.8) {
      out.push({ key: 'resonance', level: 'warn', title: '比平时偏闷', text: `${ref}，比你的基线低 ${Math.round((1 - ratio) * 100)}%，能量往低频压，接近"大白嗓"。找"哼鸣（m——）"上行音阶，感觉鼻梁发麻，再把哼鸣的位置带进开口唱。` });
    } else if (ratio > 1.25) {
      out.push({ key: 'resonance', level: 'warn', title: '比平时偏亮/偏挤', text: `${ref}，比你的基线高 ${Math.round((ratio - 1) * 100)}%，声音偏尖，可能软腭塌或舌根紧。半打哈欠 + 舌尖轻抵下牙，重新找"通"的感觉。` });
    } else {
      out.push({ key: 'resonance', level: 'good', title: '音色与你平时一致', text: `${ref}，与你的基线相差在 ±20% 内，发声位置没有异常漂移。` });
    }
  }

  // 颤音
  if (vibrato.present) {
    if (vibrato.musical) out.push({ key: 'vibrato', level: 'good', title: '颤音自然', text: `检测到约 ${vibrato.rate}Hz、±${vibrato.extent} 音分的颤音，落在歌唱家常见的 4–7Hz 区间。` });
    else if (vibrato.wild) out.push({ key: 'vibrato', level: 'warn', title: '抖动偏大/偏快', text: `颤音 ${vibrato.rate}Hz、±${vibrato.extent} 音分，超出自然范围，通常意味着喉部紧张。别再"主动抖"，用气息让它自然发生。` });
    else out.push({ key: 'vibrato', level: 'info', title: '有轻微颤音', text: `${vibrato.rate}Hz、±${vibrato.extent} 音分，还比较克制，可以顺其自然发展。` });
  } else if (r.pitch.compared === 0 && range.span > 3) {
    out.push({ key: 'vibrato', level: 'info', title: '全程直音', text: '没有检测到颤音。初学阶段直音是好事（说明喉头没乱抖），不要刻意去抖喉，等气息稳了它会自己长出来。' });
  }

  // 节奏
  if (Number.isFinite(timing.medianDelayMs)) {
    const d = timing.medianDelayMs;
    if (Math.abs(d) <= 90) out.push({ key: 'timing', level: 'good', title: '进拍准确', text: `起唱时机平均偏差 ${Math.round(d)}ms，节奏感在线。` });
    else if (d < -90) out.push({ key: 'timing', level: 'warn', title: '抢拍', text: `平均比伴奏/节拍早 ${Math.round(-d)}ms 起唱，说明你在"预判"而不是"听"。开着节拍器、只听不动嘴，跟 8 小节再唱。` });
    else out.push({ key: 'timing', level: 'warn', title: '拖拍', text: `平均比节拍晚 ${Math.round(d)}ms 起唱，常见于换气太慢或眼睛先看谱后开口。提前半拍吸气，把换气当成节奏的一部分。` });
    if (timing.matched < timing.total * 0.6) {
      out.push({ key: 'timing-miss', level: 'bad', title: '漏唱较多', text: `${timing.total} 个音里只对上了 ${timing.matched} 个起唱点，可能是速度跟不上。把速度降到 60% 先唱顺。` });
    }
  }

  // 动态
  if (Number.isFinite(dynamics.rangeDb)) {
    if (dynamics.rangeDb < 5) out.push({ key: 'dyn', level: 'warn', title: '音量几乎无起伏', text: `强弱差仅 ${num(dynamics.rangeDb, 1)} dB，整段"平铺直叙"，没有表情。试着把每句的重音字唱响 3dB。` });
    else if (dynamics.rangeDb > 30) out.push({ key: 'dyn', level: 'warn', title: '音量忽大忽小', text: `强弱差 ${num(dynamics.rangeDb, 1)} dB 过大，控制不稳，多半是气息支点没保持住。` });
  }

  // 音域
  if (Number.isFinite(range.span) && range.span > 0) {
    out.push({
      key: 'range', level: 'info', title: '本次音域',
      text: `${range.low} 到 ${range.high}，跨度约 ${range.span.toFixed(1)} 个半音。这是"本次舒适区"，不是硬性极限；每天用半音阶上下行试探，边界会慢慢拓宽。`,
    });
  }

  // 总分收尾
  const s = scores.overall;
  out.push({
    key: 'overall', level: s >= 80 ? 'good' : s >= 60 ? 'warn' : 'bad',
    title: `综合 ${s} 分`,
    text: s >= 80 ? '整体状态很好，可以开始上原速完整曲目了。'
      : s >= 60 ? '有底子，但还不能算"唱得准"。按上面最弱的一项专项练 3 天再测。'
      : '先别急着唱整首歌。当前最短板决定了上限，专项练比反复整首练有效得多。',
  });

  return out;
}

/** 给 AI 用的紧凑结构化摘要 */
export function toAiPayload(report, meta = {}) {
  return {
    练习类型: report.mode,
    时长秒: Number(report.duration.toFixed(1)),
    有声比例: Number((report.voicedRatio * 100).toFixed(0)) + '%',
    音符段数: report.segments,
    综合评分: report.scores,
    分项: {
      音准_平均偏差音分: Number.isFinite(report.pitch.meanAbsCents) ? Number(report.pitch.meanAbsCents.toFixed(1)) : null,
      音准_偏差50音分内占比: Number((report.pitch.accuracy50 * 100).toFixed(0)) + '%',
      系统性偏移音分: Number(report.pitch.biasCents.toFixed(1)),
      长音稳定度_音分: Number.isFinite(report.stabilityCents) ? Number(report.stabilityCents.toFixed(1)) : null,
      谐噪比HNR_dB: Number.isFinite(report.breath.hnr) ? Number(report.breath.hnr.toFixed(1)) : null,
      谱质心_Hz: Number.isFinite(report.resonance.centroid) ? Math.round(report.resonance.centroid) : null,
      起唱延迟_ms: Number.isFinite(report.timing.medianDelayMs) ? Math.round(report.timing.medianDelayMs) : null,
      强弱差_dB: Number.isFinite(report.dynamics.rangeDb) ? Number(report.dynamics.rangeDb.toFixed(1)) : null,
      颤音: report.vibrato.present ? `${report.vibrato.rate}Hz/±${report.vibrato.extent}音分` : '未检测到',
      本次音域: `${report.range.low}~${report.range.low ? report.range.high : ''}`,
    },
    结论: report.findings.map(f => `[${f.level}] ${f.title}：${f.text}`),
    用户资料: meta.profile || null,
    用户提问: meta.question || null,
  };
}

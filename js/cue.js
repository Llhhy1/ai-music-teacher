/**
 * cue.js — 起唱提示音
 *
 * 解决"没有标准音、一开口就跑调"：正式开唱前打两拍节拍（滴—嘀—），
 * 并在最后一拍用琴音示范首音音高，提示音正好结束在首目标音开始的时刻，
 * 学生跟着示范的尾巴无缝开口。
 *
 * 污染防护：提示音由扬声器放出、麦克风必然录到，因此 Analyzer 用
 * ignoreBefore = leadIn 丢弃这段时间的帧——提示音不会混进音准/节奏统计。
 */
let ctx = null;

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

/** 节拍蜂鸣 */
function beepAt(t, freq, dur, vol) {
  const c = ac();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}

/** 琴音（基频 + 一个八度泛音，简单包络模拟钢琴） */
function toneAt(t, freq, dur, vol = 0.26) {
  const c = ac();
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  g.gain.setValueAtTime(vol, t + dur * 0.55);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(c.destination);
  for (const [type, mul, lvl] of [['triangle', 1, 1], ['sine', 2, 0.22]]) {
    const o = c.createOscillator();
    const og = c.createGain();
    o.type = type;
    o.frequency.value = freq * mul;
    og.gain.value = lvl;
    o.connect(og).connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

/**
 * 播放开唱提示（与录音同时开始，结束于首目标音时刻）
 * @param {{leadIn:number, spb:number, midi:number}} o
 *   leadIn 秒数 = 时间轴首音开始时刻（也是 Analyzer 忽略帧的截止点）
 *   spb    每拍秒数
 *   midi   首音音高
 * @returns {Promise<void>} resolve 于 leadIn 时刻
 */
export async function playCue({ leadIn, spb, midi }) {
  let c;
  try {
    c = ac();
    if (c.state === 'suspended') await c.resume();
  } catch {
    return; // 没有音频设备就静默跳过，练习照常开始
  }

  const t0 = c.currentTime + 0.05;
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const tTone = t0 + Math.max(0, leadIn - spb);   // 末拍：示范首音
  beepAt(t0 + Math.max(0, leadIn - 2 * spb), 1320, 0.07, 0.20);  // 预备拍
  beepAt(tTone, 1760, 0.09, 0.24);                                 // 进拍
  toneAt(tTone, f, Math.min(spb, leadIn));

  await new Promise(r => setTimeout(r, Math.max(0, (leadIn + 0.05) * 1000)));
}

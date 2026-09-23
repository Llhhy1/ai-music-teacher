/**
 * test/pipeline.test.mjs — 端到端：合成演唱 → 分析管线 → 诊断报告
 * 验证的不只是算法，还有"目标音高对齐 / 段切分 / 节奏匹配 / 打分"这些业务逻辑。
 * 运行：npm test
 */
import { Analyzer } from '../js/pipeline.js';
import { DemoSource, buildImprov } from '../js/demo.js';
import { LESSONS, buildTimeline, getLesson } from '../js/lessons.js';
import { toAiPayload } from '../js/metrics.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name} ${detail}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

/** 用演示音源走完整条管线（非实时，一次性喂完） */
function run(timeline, mode, opts = {}) {
  const an = new Analyzer({ sampleRate: 44100, silenceRms: 0.004, ...opts });
  an.begin({ target: mode === 'free' ? null : timeline, mode, ...opts });
  const src = new DemoSource(timeline, (c) => an.push(c));
  let guard = 0;
  for (;;) {
    const chunk = src.render(1024);
    if (chunk === null || ++guard > 4000) break;
    an.push(chunk);
  }
  return an.finalize();
}

const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

/* ───────────── 1. 时间轴 ───────────── */
console.log('\n[1] buildTimeline 节拍换算');
{
  const tw = buildTimeline(getLesson('song-twinkle'));
  const beats = tw.notes.reduce((a, n) => a + n.beats, 0);
  const spb = 60 / 88;
  const expected = 1.2 + beats * spb + 0.8;   // leadIn 默认 1.2s
  ok('《小星星》时长符合节拍', Math.abs(tw.duration - expected) < 0.01,
     `dur=${tw.duration.toFixed(2)}s beats=${beats}`);
  ok('音符数 = 14', tw.notes.length === 14, `n=${tw.notes.length}`);
  ok('歌词与音符一一对应', tw.notes.every(n => n.lyric.length > 0));

  const onset = buildTimeline(getLesson('breath-onset'));
  const sounding = onset.notes.reduce((a, n) => a + n.beats, 0);
  ok('休止符占用时间', Math.abs(sounding - 7) < 1e-6 && Math.abs(onset.duration - (1.2 + 8.5 * 0.5 + 0.8)) < 0.01,
     `dur=${onset.duration.toFixed(2)}s 发声拍=${sounding}`);

  const rng = buildTimeline(getLesson('range-test'));
  ok('音域测试 36 个音', rng.notes.length === 36, `n=${rng.notes.length}`);
  ok('音域测试含 A3..E5', Math.min(...rng.notes.map(n => n.midi)) === 57 && Math.max(...rng.notes.map(n => n.midi)) === 74);
}

/* ───────────── 2. 跟唱模式端到端 ───────────── */
console.log('\n[2] 跟唱模式（《小星星》合成"初学者"）');
const tw = buildTimeline(getLesson('song-twinkle'));
const repMelody = run(tw, 'melody');

ok('帧数充足', repMelody.frames > 80, `frames=${repMelody.frames}`);
ok('有声比例合理', inRange(repMelody.voicedRatio, 0.35, 1), `${(repMelody.voicedRatio * 100).toFixed(0)}%`);
ok('时长 ≈ 时间轴时长', inRange(repMelody.duration, tw.duration - 0.5, tw.duration + 0.5),
   `${repMelody.duration.toFixed(2)}s vs ${tw.duration.toFixed(2)}s`);

ok('目标音高对齐成功（非 0 也非乱码）', inRange(repMelody.pitch.meanAbsCents, 10, 80),
   `meanAbs=${repMelody.pitch.meanAbsCents?.toFixed(1)} 音分`);
ok('被比较的帧数占多数', repMelody.pitch.compared > repMelody.voicedFrames * 0.5,
   `${repMelody.pitch.compared}/${repMelody.voicedFrames}`);
ok('50 音分内命中率在中等水平', inRange(repMelody.pitch.accuracy50, 0.1, 1),
   `${(repMelody.pitch.accuracy50 * 100).toFixed(0)}%`);
ok('逐音偏差表已生成', repMelody.pitch.noteScores.length >= 10, `n=${repMelody.pitch.noteScores.length}`);
ok('逐音表带歌词', repMelody.pitch.noteScores.every(n => typeof n.lyric === 'string'));

ok('节奏匹配到起唱点', repMelody.timing.matched >= 6, `${repMelody.timing.matched}/${repMelody.timing.total}`);
ok('起唱延迟可测（合成延迟在 ±260ms 内）',
   Number.isFinite(repMelody.timing.medianDelayMs) && Math.abs(repMelody.timing.medianDelayMs) < 300,
   `${repMelody.timing.medianDelayMs?.toFixed(0)}ms`);

ok('音域落在曲目范围内', inRange(repMelody.range.lowMidi, 58, 62) && inRange(repMelody.range.highMidi, 67, 71),
   `${repMelody.range.low}~${repMelody.range.high}`);
ok('HNR 可测', inRange(repMelody.breath.hnr, 5, 40), `${repMelody.breath.hnr?.toFixed(1)}dB`);
ok('谱质心可测', inRange(repMelody.resonance.centroid, 100, 6000), `${Math.round(repMelody.resonance.centroid)}Hz`);

/* ───────────── 3. 打分与结论文本 ───────────── */
console.log('\n[3] 打分与诊断结论文本');
{
  const s = repMelody.scores;
  const entries = { 综合: s.overall, 音准: s.pitch, 节奏: s.rhythm, 气息: s.breath, 稳定: s.stability, 音色: s.resonance };
  for (const [k, v] of Object.entries(entries)) {
    if (v === null) continue;
    ok(`${k} 分在 0–100`, inRange(v, 0, 100), `=${v}`);
  }
  ok('核心 4 项分数齐全', [s.pitch, s.rhythm, s.breath, s.stability].every(v => v != null));
  ok('无个人基线时音色分为 null（不硬给绝对好坏）', s.resonance === null, `=${s.resonance}`);
  ok('音色无基线时给出"暂无基线"结论',
     repMelody.findings.some(f => f.key === 'resonance' && f.level === 'info' && /基线/.test(f.text)));

  // 有基线时才做"比平时偏暗/偏亮"的自比较
  const repBase = run(tw, 'melody', { toneBaseline: Math.round(repMelody.resonance.centroid) });
  const sb = repBase.scores;
  ok('有基线时音色分在 0–100', inRange(sb.resonance, 0, 100), `=${sb.resonance}`);
  ok('基线=本人中位数时音色分接近满分', sb.resonance >= 85, `=${sb.resonance}`);
  ok('有基线时音色结论为自比较',
     repBase.findings.some(f => f.key === 'resonance' && /基线/.test(f.text) && f.level === 'good'));
  const repDark = run(tw, 'melody', { toneBaseline: Math.round(repMelody.resonance.centroid * 2) });
  ok('基线偏高一倍时判"比平时偏闷"',
     repDark.findings.some(f => f.key === 'resonance' && f.level === 'warn' && /偏闷/.test(f.title)),
     `基线=${Math.round(repMelody.resonance.centroid * 2)}Hz`);
  ok('音色分不计入时总分仍有效', inRange(s.overall, 0, 100), `=${s.overall}`);
  ok('结论条数合理', repMelody.findings.length >= 5, `n=${repMelody.findings.length}`);
  ok('每条结论都有标题和正文',
     repMelody.findings.every(f => f.title && f.text && f.text.length > 10));
  ok('结论提到具体数字',
     repMelody.findings.some(f => /\d/.test(f.text)), '含数字');
  ok('存在"最需要单独练的音"结论',
     repMelody.findings.some(f => f.key === 'pitch-worst'));
  ok('末尾有综合分结论',
     repMelody.findings.at(-1).key === 'overall');
  ok('level 取值合法',
     repMelody.findings.every(f => ['good', 'warn', 'bad', 'info'].includes(f.level)));

  const payload = toAiPayload(repMelody, { question: 'test' });
  ok('AI 载荷可序列化', (() => { JSON.stringify(payload); return true; })());
  ok('AI 载荷含音准偏差', payload.分项.音准_平均偏差音分 != null, `=${payload.分项.音准_平均偏差音分}`);
  ok('AI 载荷含 HNR', payload.分项.谐噪比HNR_dB != null, `=${payload.分项.谐噪比HNR_dB}`);
}

/* ───────────── 4. 自由清唱 ───────────── */
console.log('\n[4] 自由清唱（无目标音高）');
{
  const improv = buildImprov();
  const rep = run(improv, 'free');
  ok('mode = free', rep.mode === 'free');
  ok('无节奏分', rep.scores.rhythm === null, `rhythm=${rep.scores.rhythm}`);
  ok('无音准比较目标', rep.pitch.compared === 0, `compared=${rep.pitch.compared}`);
  ok('仍能给出稳定性分数', inRange(rep.scores.stability, 0, 100), `=${rep.scores.stability}`);
  ok('测出音域跨度', inRange(rep.range.span, 8, 20), `span=${rep.range.span?.toFixed(1)}`);
  ok('综合分有效', inRange(rep.scores.overall, 0, 100), `=${rep.scores.overall}`);
  ok('有音域结论文本', rep.findings.some(f => f.key === 'range'));
  ok('series 供绘图使用', rep.series.length > 50, `n=${rep.series.length}`);
}

/* ───────────── 5. 音域测试 ───────────── */
console.log('\n[5] 音域测试模式');
{
  const rngTl = buildTimeline(getLesson('range-test'));
  const rep = run(rngTl, 'range');
  ok('mode = range', rep.mode === 'range');
  ok('低音边界 ≈ A3', inRange(rep.range.lowMidi, 55.5, 58.5), `low=${rep.range.lowMidi?.toFixed(1)} (${rep.range.low})`);
  ok('高音边界 ≈ E5', inRange(rep.range.highMidi, 72.5, 75.5), `high=${rep.range.highMidi?.toFixed(1)} (${rep.range.high})`);
  ok('跨度 ≈ 17 半音', inRange(rep.range.span, 15, 19), `span=${rep.range.span?.toFixed(1)}`);
}

/* ───────────── 6. 边界条件 ───────────── */
console.log('\n[6] 边界与鲁棒性');
{
  const an = new Analyzer({ sampleRate: 44100 });
  an.begin({ target: null, mode: 'free' });
  // 纯静音
  for (let i = 0; i < 400; i++) an.push(new Float32Array(1024));
  const rep = an.finalize();
  ok('纯静音不崩', rep != null);
  ok('纯静音不误报有声帧', rep.voicedFrames === 0, `voiced=${rep.voicedFrames}`);
  ok('纯静音综合分仍有值', inRange(rep.scores.overall, 0, 100), `=${rep.scores.overall}`);
  ok('纯静音给出结论文本', rep.findings.length > 0, `n=${rep.findings.length}`);
}
{
  const an = new Analyzer({ sampleRate: 44100 });
  an.begin({ target: null, mode: 'free' });
  const r = an.finalize();
  ok('零帧也能 finalize', r != null && r.frames === 0);
}
{
  const an = new Analyzer({ sampleRate: 44100, eco: true });
  an.begin({ target: null, mode: 'free' });
  const src = new DemoSource(buildImprov(), c => an.push(c));
  for (let i = 0; i < 400; i++) { const c = src.render(1024); if (!c) break; an.push(c); }
  const rep = an.finalize();
  ok('省电模式帧率减半但仍可用', rep.frames > 30 && rep.frames < 160, `frames=${rep.frames}`);
}
{
  // 起唱提示音会被麦克风录到，ignoreBefore 必须把这段时间的帧丢干净
  const tw = buildTimeline(getLesson('song-twinkle'));
  const full = run(tw, 'melody');
  const ign = run(tw, 'melody', { ignoreBefore: 5 });
  ok('ignoreBefore 丢弃提示音段的帧', ign.frames <= full.frames - 50,
    `full=${full.frames} ign=${ign.frames}`);
  ok('ignoreBefore 后首帧 ≥ 截止点', ign.series.length > 0 && ign.series[0].t >= 5 - 1e-6,
    `firstT=${ign.series[0]?.t}`);
  ok('ignoreBefore 不影响最终得分', inRange(ign.scores.overall, 0, 100),
    `=${ign.scores.overall}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);

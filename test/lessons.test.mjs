/**
 * test/lessons.test.mjs — 曲库结构与内容回归
 * 防止手写曲谱时出现的低级错误：音符/歌词/节拍数量对不上、音高越界、ID 重复。
 * 运行：npm test
 */
import { LESSONS, COURSES, DICTATION_LINES, buildTimeline, getLesson } from '../js/lessons.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name} ${detail}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

console.log('\n[1] LESSONS 结构合法性');
{
  const ids = new Set();
  let badId = 0, badBpm = 0, badPitch = 0, badBeats = 0, badLyric = 0, emptyTips = 0;
  for (const l of LESSONS) {
    if (!l.id || ids.has(l.id)) badId++;
    ids.add(l.id);
    if (!(l.bpm >= 30 && l.bpm <= 240)) badBpm++;
    if (!l.notes?.length) badId++;
    if (!l.tips?.length) emptyTips++;
    for (const n of l.notes) {
      if (n.m != null && !(n.m >= 36 && n.m <= 88)) badPitch++;
      if (!(Number.isFinite(n.b) && n.b > 0 && n.b <= 8)) badBeats++;
      if (typeof n.l !== 'string') badLyric++;
    }
  }
  ok('课程 ≥10 个且 ID 唯一非空', badId === 0 && LESSONS.length >= 10,
    `n=${LESSONS.length} bad=${badId}`);
  ok('bpm 全部在 30–240', badBpm === 0, `bad=${badBpm}`);
  ok('MIDI 音高全部在 36–88', badPitch === 0, `bad=${badPitch}`);
  ok('节拍全部在 (0, 8]', badBeats === 0, `bad=${badBeats}`);
  ok('歌词字段都是字符串', badLyric === 0, `bad=${badLyric}`);
  ok('每课都有 tips', emptyTips === 0, `bad=${emptyTips}`);
}

console.log('\n[2] 歌曲曲谱点数与音域');
{
  const tiger = getLesson('song-tiger');
  ok('《两只老虎》存在', tiger != null);
  ok('《两只老虎》32 个音', tiger?.notes.length === 32, `n=${tiger?.notes.length}`);
  {
    const pitches = tiger.notes.map(n => n.m);
    ok('《两只老虎》音域 G3–A4', Math.min(...pitches) === 55 && Math.max(...pitches) === 69,
      `${Math.min(...pitches)}..${Math.max(...pitches)}`);
    ok('《两只老虎》歌词逐音都有字', tiger.notes.every(n => n.l.length > 0));
  }

  const bday = getLesson('song-birthday');
  ok('《生日快乐》存在', bday != null);
  ok('《生日快乐》25 个音', bday?.notes.length === 25, `n=${bday?.notes.length}`);
  {
    const pitches = bday.notes.map(n => n.m);
    ok('《生日快乐》音域 G3–G4', Math.min(...pitches) === 55 && Math.max(...pitches) === 67,
      `${Math.min(...pitches)}..${Math.max(...pitches)}`);
    const empty = bday.notes.filter(n => n.l === '').length;
    ok('《生日快乐》最多 1 个无字音（拖腔）', empty <= 1, `empty=${empty}`);
    // 附点节奏：句首 0.75 + 0.25
    ok('《生日快乐》句首附点节奏', bday.notes[0].b === 0.75 && bday.notes[1].b === 0.25,
      `${bday.notes[0].b}/${bday.notes[1].b}`);
  }

  const legend = getLesson('song-legend');
  ok('《传奇》存在', legend != null);
  ok('《传奇》146 个音符条目', legend?.notes.length === 146, `n=${legend?.notes.length}`);
  {
    const pitches = legend.notes.filter(n => n.m != null).map(n => n.m);
    ok('《传奇》音域 G#3–C#5', Math.min(...pitches) === 56 && Math.max(...pitches) === 73,
      `${Math.min(...pitches)}..${Math.max(...pitches)}`);
    // 1=E 原调：首音"只"应为 E4(64)
    ok('《传奇》首音"只"=E4（1=E 原调）',
      legend.notes[1].m === 64 && legend.notes[1].l === '只',
      `${legend.notes[1].m}/${legend.notes[1].l}`);
    // 副歌起句"宁愿相信"
    const first = legend.notes.find(n => n.l === '宁');
    ok('《传奇》副歌"宁"=E4', first?.m === 64, `m=${first?.m}`);
    // 全曲 96 拍
    const totalBeats = legend.notes.reduce((s, n) => s + n.b, 0);
    ok('《传奇》合计 96 拍', totalBeats === 96, `b=${totalBeats}`);
  }

  const heels = getLesson('song-red-heels');
  ok('《红色高跟鞋》存在', heels != null);
  ok('《红色高跟鞋》46 个音符条目', heels?.notes.length === 46, `n=${heels?.notes.length}`);
  {
    const pitches = heels.notes.filter(n => n.m != null).map(n => n.m);
    ok('《红色高跟鞋》音域 A3–B4', Math.min(...pitches) === 57 && Math.max(...pitches) === 71,
      `${Math.min(...pitches)}..${Math.max(...pitches)}`);
    // 1=D 原调：起句"该"应为 F#4(66)
    ok('《红色高跟鞋》起句"该"=F#4（1=D 原调）',
      heels.notes[1].m === 66 && heels.notes[1].l === '该',
      `${heels.notes[1].m}/${heels.notes[1].l}`);
    const last = heels.notes[heels.notes.length - 1];
    ok('《红色高跟鞋》收在"觉"长音（1.5 拍）', last.l === '觉' && last.b === 1.5,
      `${last.l}/${last.b}`);
    const totalBeats = heels.notes.reduce((s, n) => s + n.b, 0);
    ok('《红色高跟鞋》合计 30 拍', totalBeats === 30, `b=${totalBeats}`);
  }
}

console.log('\n[3] buildTimeline 对全部曲目可用');
{
  let bad = 0, badOrder = 0;
  for (const l of LESSONS) {
    const tl = buildTimeline(l);
    if (!(Number.isFinite(tl.duration) && tl.duration > 0)) bad++;
    let prev = -1;
    for (const n of tl.notes) {
      if (!(Number.isFinite(n.start) && n.start >= 1.2 && n.end > n.start)) bad++;
      if (n.start < prev) badOrder++;
      prev = n.start;
    }
  }
  ok('时长与起始时间全部合法', bad === 0, `bad=${bad}`);
  ok('音符时间轴单调递增', badOrder === 0, `bad=${badOrder}`);
}

console.log('\n[4] 课程与听写行');
{
  ok('COURSES ≥4', COURSES.length >= 4, `n=${COURSES.length}`);
  let badBlock = 0;
  for (const c of COURSES) if (!c.title || !c.blocks?.length) badBlock++;
  ok('每门课有标题和内容块', badBlock === 0, `bad=${badBlock}`);
  ok('DICTATION_LINES ≥5', DICTATION_LINES.length >= 5, `n=${DICTATION_LINES.length}`);
  ok('getLesson 未命中返回 null', getLesson('nope') === null);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);

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

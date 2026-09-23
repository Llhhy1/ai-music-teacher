/**
 * app.js — 主控制器
 *
 * 数据流：麦克风 → AudioWorklet → 1024 样本块 → 环形缓冲
 *          →（每 2 块）YIN 基频 + FFT 谱特征 → Session 逐帧累积
 *          → finalize() 出报告 → 可选发送给大模型做口语化点评
 */

import { midiToName, midiToSolfège } from './pitch.js';
import { clamp, median } from './dsp.js';
import { Analyzer, WIN, HOP } from './pipeline.js';
import { Session, toAiPayload } from './metrics.js';
import { LESSONS, COURSES, DICTATION_LINES, buildTimeline, getLesson } from './lessons.js';
import { PRESETS, loadSettings, saveSettings, isConfigured, streamChat, buildReportMessage, localFallbackText } from './ai.js';
import { DemoSource, buildImprov } from './demo.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let state = {
  mode: 'melody',
  lesson: LESSONS[0],
  report: null,
  dictIdx: 0,
  eco: false,
  silenceRms: 0.004,
};

/* ══════════════ 通用 ══════════════ */

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 极简排版：**粗体** `代码` 换行 */
function miniMd(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function goto(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  window.scrollTo({ top: 0 });
}

function fmtTime(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

const LEVEL_ICON = { good: '✅', warn: '⚠️', bad: '❌', info: 'ℹ️' };

/* ══════════════ 练习选择 ══════════════ */

const MODE_CATS = {
  melody: null,        // 全部 melody 课程
  free: '__free__',
  range: '__range__',
  diction: '__diction__',
};

function renderLessons() {
  const pane = $('#lessonPane'), dictPane = $('#dictionPane');
  if (state.mode === 'diction') {
    pane.classList.add('hidden');
    dictPane.classList.remove('hidden');
    renderDict();
    return;
  }
  pane.classList.remove('hidden');
  dictPane.classList.add('hidden');

  let list, title;
  if (state.mode === 'free') {
    title = '自由清唱诊断';
    $('#lessonList').innerHTML = `
      <div class="lesson sel" data-free="1">
        <div class="lesson-ico">🎤</div>
        <div class="lesson-body"><b>60 秒自由清唱</b><span>随便唱段你会的歌，测音域 / 气息 / 共鸣 / 稳定性</span></div>
        <div class="lesson-tag">无目标音高</div>
      </div>`;
    $('#startName').textContent = '自由清唱 60 秒';
    $('#startGoal').textContent = '没有标准答案，输出的是你的嗓音画像';
    $('#btnDemo').classList.remove('hidden');
    $('#lessonCount').textContent = '';
    $('#lessonTitle').textContent = title;
    bindLessonClicks();
    return;
  }

  if (state.mode === 'range') {
    title = '音域测试';
    list = LESSONS.filter(l => l.mode === 'range');
  } else {
    title = '选择一项练习';
    list = LESSONS.filter(l => l.mode === 'melody');
  }

  $('#lessonTitle').textContent = title;
  $('#lessonCount').textContent = `${list.length} 项`;
  $('#lessonList').innerHTML = list.map(l => {
    const ico = { 音准: '🎯', 气息: '🫁', 共鸣: '🔔', 歌曲: '🎵', 音域: '🎹' }[l.cat] || '♪';
    return `<div class="lesson ${l.id === state.lesson?.id ? 'sel' : ''}" data-id="${l.id}">
      <div class="lesson-ico">${ico}</div>
      <div class="lesson-body"><b>${escapeHtml(l.title)}</b><span>${escapeHtml(l.subtitle)}</span></div>
      <div class="lesson-tag">${l.cat}</div>
    </div>`;
  }).join('');

  if (!list.some(l => l.id === state.lesson?.id)) state.lesson = list[0];
  syncStartCard();
  bindLessonClicks();
}

function bindLessonClicks() {
  $$('#lessonList .lesson').forEach(el => {
    el.onclick = () => {
      if (el.dataset.free) { state.lesson = null; }
      else { state.lesson = getLesson(el.dataset.id); }
      $$('#lessonList .lesson').forEach(x => x.classList.toggle('sel', x === el));
      syncStartCard();
    };
  });
}

function syncStartCard() {
  const l = state.lesson;
  if (!l) return;
  $('#startName').textContent = l.title;
  $('#startGoal').textContent = l.goal || l.subtitle;
}

/* ══════════════ 咬字校对 ══════════════ */

function renderDict() {
  const line = DICTATION_LINES[state.dictIdx];
  $('#dictLine').textContent = line.text;
  $('#dictResult').innerHTML = '';
  const SR_cls = window.SpeechRecognition || window.webkitSpeechRecognition;
  $('#dictHint').innerHTML = SR_cls
    ? `提示：${escapeHtml(line.hint)}`
    : `<span style="color:var(--warn)">当前浏览器不支持语音识别（推荐 Chrome / Edge）。你仍然可以用其他练习做诊断。</span>`;
  $('#dictStart').disabled = !SR_cls;
}

function lcsDiff(target, actual) {
  const n = target.length, m = actual.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = target[i] === actual[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const res = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (target[i] === actual[j]) { res.push({ c: target[i], s: 'g' }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { res.push({ c: target[i], s: 'm' }); i++; }
    else { res.push({ c: actual[j], s: 'r' }); j++; }
  }
  while (i < n) { res.push({ c: target[i++], s: 'm' }); }
  while (j < m) { res.push({ c: actual[j++], s: 'r' }); }
  return res;
}

let recognition = null;
function startDictation() {
  const line = DICTATION_LINES[state.dictIdx];
  const Cls = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Cls) return;
  try { recognition?.stop(); } catch { /* ignore */ }
  recognition = new Cls();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  const out = $('#dictResult');
  const btn = $('#dictStart');
  btn.disabled = true;
  btn.textContent = '正在听…';

  recognition.onresult = (e) => {
    const text = [...e.results].map(r => r[0].transcript).join('').replace(/[\s，。！？,.!?]/g, '');
    if (e.results[e.results.length - 1].isFinal) {
      const diff = lcsDiff(line.text, text.slice(0, Math.max(line.text.length + 4, text.length)));
      const okCnt = diff.filter(d => d.s === 'g').length;
      out.innerHTML = diff.map(d =>
        `<span class="${d.s}">${escapeHtml(d.c)}</span>`).join('') +
        `<div style="font-size:13px;color:var(--tx2);margin-top:6px">识别到「${escapeHtml(text)}」 · 吻合度 ${Math.round(okCnt / line.text.length * 100)}%</div>`;
      btn.disabled = false;
      btn.textContent = '再来一次';
    } else {
      out.innerHTML = `<span style="font-size:15px;color:var(--tx2)">${escapeHtml(text)}…</span>`;
    }
  };
  recognition.onerror = (e) => {
    btn.disabled = false;
    btn.textContent = '开始识别';
    out.innerHTML = `<span style="font-size:14px;color:var(--bad)">识别失败：${escapeHtml(e.error)}</span>`;
  };
  recognition.onend = () => { btn.disabled = false; btn.textContent = '开始识别'; };
  recognition.start();
}

/* ══════════════ 音频引擎 ══════════════ */

class Engine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.analyzer = null;
    this.demo = null;
    this.running = false;
    this.target = null;
    this.onFrame = null;
    this.onTick = null;
    this._raf = 0;
  }

  get frames() { return this.analyzer ? this.analyzer.frames : []; }

  /** 打开音频输入。real=false 时不碰麦克风（演示模式） */
  async start(real) {
    this.stop();
    this.running = true;
    this.demo = null;

    if (real) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.sampleRate = this.ctx.sampleRate;

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false, noiseSuppression: false,
            autoGainControl: false, channelCount: 1,
          },
        });
      } catch (err) {
        try { this.ctx.close(); } catch { /* ignore */ }
        this.ctx = null;
        this.running = false;
        throw new Error(err.name === 'NotAllowedError'
          ? '麦克风权限被拒绝。请在地址栏的权限图标里允许麦克风后重试。'
          : '无法访问麦克风：' + (err.message || err.name));
      }

      const src = this.ctx.createMediaStreamSource(this.stream);
      try {
        await this.ctx.audioWorklet.addModule('js/recorder-worklet.js');
        this.node = new AudioWorkletNode(this.ctx, 'capture-processor');
        this.node.port.onmessage = (e) => this.push(e.data);
      } catch {
        // 兜底：老浏览器用 ScriptProcessor（必须接进图里才会跑）
        const sp = this.ctx.createScriptProcessor(HOP, 1, 1);
        sp.onaudioprocess = (e) => this.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        this.node = sp;
      }
      src.connect(this.node);
      try { this.node.connect(this.ctx.destination); } catch { /* ignore */ }
    } else {
      this.sampleRate = 44100;
    }

    this.analyzer = new Analyzer({
      sampleRate: this.sampleRate,
      silenceRms: state.silenceRms,
      eco: state.eco,
      toneBaseline: loadToneBaseline(),
    });
    this.analyzer.onFrame = (f) => this.onFrame?.(f);
  }

  /** 演示音源：必须在 arm() 之前调用 */
  startDemo(timeline) {
    this.demo = new DemoSource(timeline, (chunk) => this.push(chunk));
  }

  arm(target, mode) {
    this.target = target;
    this.analyzer.begin({ target, mode });
    this.demo?.start();
    this._loop();
  }

  push(chunk) {
    if (!this.running || !this.analyzer) return;
    this.analyzer.push(chunk);
  }

  _loop() {
    cancelAnimationFrame(this._raf);
    const tick = () => {
      if (!this.running) return;
      this.onTick?.();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.demo?.stop();
    this.demo = null;
    try { this.node?.disconnect(); } catch { /* ignore */ }
    if (this.node?.port) this.node.port.onmessage = null;
    if (this.node) this.node.onaudioprocess = null;
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.node = null; this.stream = null; this.ctx = null;
  }

  finalize() {
    const r = this.analyzer ? this.analyzer.finalize() : null;
    this.stop();
    return r;
  }
}

const engine = new Engine();

/* ══════════════ 练习会话 ══════════════ */

let sessionMode = 'melody';

async function beginSession(isDemo) {
  const lesson = state.lesson;
  $('#sessionOverlay').classList.remove('hidden');
  $('#sessTitle').textContent = lesson ? lesson.title : '自由清唱';
  $('#sessScore').textContent = '--';
  $('#sessTimer').textContent = '00:00';
  liveStats = { abs: [], n: 0, score: 0 };

  try {
    await engine.start(!isDemo);
  } catch (err) {
    $('#sessionOverlay').classList.add('hidden');
    toast(err.message, 4600);
    return;
  }

  // 3 秒倒计时
  await countdown();
  if (!engine.running) return;

  const mode = state.mode === 'free' ? 'free' : (lesson ? lesson.mode : 'melody');
  sessionMode = mode;

  const target = mode === 'free' ? null : buildTimeline(lesson || LESSONS[0], 1.0);
  // 自由清唱没有目标音高，但演示模式仍需要一段可分析的声音
  const source = target || buildImprov();

  engine.onFrame = updateLive;
  engine.onTick = updateTick;
  if (isDemo) engine.startDemo(source);
  engine.arm(target, mode);

  if (mode === 'free') {
    // 自由清唱：60 秒自动结束
    setTimeout(() => { if (engine.running) endSession(); }, 60000);
  }
}

function countdown() {
  return new Promise(res => {
    const el = $('#countdown');
    const span = el.querySelector('span');
    el.classList.remove('hidden');
    let n = 3;
    span.textContent = n;
    const iv = setInterval(() => {
      n--;
      if (n <= 0) {
        clearInterval(iv);
        el.classList.add('hidden');
        res();
      } else {
        span.style.animation = 'none';
        void span.offsetWidth;
        span.style.animation = '';
        span.textContent = n;
      }
    }, 900);
  });
}

let liveStats = { abs: [], n: 0, score: 0 };

function updateLive(f) {
  // 实时数字
  const hasPitch = f.freq > 0 && !f.silence;
  $('#liveNote').textContent = hasPitch ? midiToName(f.midi) : '--';
  $('#liveSol').textContent = hasPitch ? midiToSolfège(f.midi) : '';
  $('#liveNote').style.color = hasPitch ? 'var(--tx)' : 'var(--tx2)';

  if (f.targetMidi != null) {
    $('#liveLyric').textContent = currentLyric(f.t) || '';
    const c = f.deltaCents;
    const el = $('#liveCents');
    if (Number.isFinite(c)) {
      el.textContent = `${c > 0 ? '+' : ''}${Math.round(c)}`;
      el.style.color = Math.abs(c) <= 25 ? 'var(--ok)' : Math.abs(c) <= 50 ? 'var(--warn)' : 'var(--bad)';
      liveStats.abs.push(Math.abs(c));
      if (liveStats.abs.length > 400) liveStats.abs.shift();
    } else {
      el.textContent = '未起唱';
      el.style.color = 'var(--tx2)';
    }
  } else {
    $('#liveLyric').textContent = sessionMode === 'free' ? '自由清唱' : '';
    $('#liveCents').textContent = hasPitch ? '—' : '无信号';
    $('#liveCents').style.color = 'var(--tx2)';
    liveStats.n++;
  }

  $('#stPitch').textContent = liveStats.abs.length
    ? Math.round(clamp(100 - median(liveStats.abs) * 1.15, 0, 100))
    : '--';
  $('#stHnr').textContent = hasPitch && f.hnr > -50 ? `${f.hnr.toFixed(0)}dB` : '--';
  $('#stCent').textContent = hasPitch && f.centroid > 0 ? `${Math.round(f.centroid)}` : '--';
  $('#stVol').textContent = `${Math.round(20 * Math.log10(Math.max(f.rms, 1e-5)))}`;

  drawCentMeter(f);
}

function currentLyric(t) {
  const target = engine.target;
  if (!target) return '';
  const n = target.notes.find(n => t >= n.start - 0.12 && t < n.end + 0.12);
  return n ? n.lyric : '';
}

function updateTick() {
  const f = engine.frames;
  if (!f.length) return;
  const t = f[f.length - 1].t;
  $('#sessTimer').textContent = fmtTime(t);

  // 演示模式：曲子放完就自动出报告
  if (engine.demo && engine.target && t > engine.target.duration + 0.2) { endSession(); return; }

  if (sessionMode !== 'free' && liveStats.abs.length > 6) {
    $('#sessScore').textContent = Math.round(clamp(100 - median(liveStats.abs) * 1.15, 0, 100));
  } else if (sessionMode === 'free') {
    $('#sessScore').textContent = Math.round(t) + 's';
  }
  drawRoll();
}

async function endSession() {
  if (!engine.running) return;
  liveStats = { abs: [], n: 0, score: 0 };
  const report = engine.finalize();
  $('#sessionOverlay').classList.add('hidden');
  if (!report || report.frames < 10) {
    toast('有效音频太少，请靠近麦克风（约 15cm）再试一次。', 3600);
    return;
  }
  state.report = report;
  saveReport(report);

  // 用本次音色刷新个人基线（EMA），下次就能做"比平时偏暗/偏亮"的对比
  const nb = engine.analyzer?.updateBaseline?.(report);
  if (Number.isFinite(nb)) {
    try { localStorage.setItem('amt.toneBaseline', String(nb)); } catch { /* quota */ }
  }

  renderReport();
  goto('report');
  toast(`练习完成 · 综合 ${report.scores.overall} 分`);
}

/* ══════════════ 可视化 ══════════════ */

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr; cv.height = h * dpr;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawRoll() {
  const cv = $('#pianoRoll');
  if (!cv || !cv.getBoundingClientRect().width) return;
  const { ctx, w, h } = setupCanvas(cv);
  const frames = engine.frames;
  const target = engine.target;
  const now = frames.length ? frames[frames.length - 1].t : 0;

  const WIN_SEC = 6;
  const HEAD = 0.62;
  const t0 = now - WIN_SEC * HEAD;
  const t1 = t0 + WIN_SEC;
  const x = t => ((t - t0) / WIN_SEC) * w;

  // Y 轴范围
  let lo = 55, hi = 76;
  if (target) {
    const ms = target.notes.map(n => n.midi);
    lo = Math.min(...ms) - 3; hi = Math.max(...ms) + 3;
  } else {
    const ms = frames.filter(f => f.freq > 0).map(f => f.midi);
    if (ms.length > 5) { lo = Math.min(...ms) - 3; hi = Math.max(...ms) + 3; }
  }
  if (hi - lo < 10) { const c = (hi + lo) / 2; lo = c - 5; hi = c + 5; }
  const y = m => h - ((m - lo) / (hi - lo)) * h;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b1122';
  ctx.fillRect(0, 0, w, h);

  // 音高网格
  ctx.font = '9px system-ui';
  for (let m = Math.ceil(lo); m <= hi; m++) {
    const isC = ((m % 12) + 12) % 12 === 0;
    ctx.strokeStyle = isC ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.045)';
    ctx.beginPath();
    ctx.moveTo(0, y(m)); ctx.lineTo(w, y(m)); ctx.stroke();
    if (isC) {
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.fillText(midiToName(m), 4, y(m) - 3);
    }
  }

  // 目标音符条
  if (target) {
    for (const n of target.notes) {
      const nx = x(n.start), nw = (n.end - n.start) / WIN_SEC * w;
      if (nx + nw < 0 || nx > w) continue;
      const yy = y(n.midi);
      const hh = Math.max(6, h / (hi - lo) * 0.62);
      ctx.fillStyle = 'rgba(139,92,246,.34)';
      ctx.strokeStyle = 'rgba(167,139,250,.85)';
      ctx.lineWidth = 1;
      roundRect(ctx, nx, yy - hh / 2, Math.max(nw - 2, 3), hh, 4);
      ctx.fill(); ctx.stroke();
      if (nw > 34 && n.lyric) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(n.lyric, nx + nw / 2, yy + 4);
        ctx.textAlign = 'left';
      }
    }
  }

  // 实际演唱曲线
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  let prev = null;
  for (const f of frames) {
    if (f.t < t0 || f.t > t1) continue;
    const on = f.freq > 0 && !f.silence;
    if (!on) { prev = null; continue; }
    const px = x(f.t), py = y(f.midi);
    if (prev && f.t - prev.t < 0.25) {
      const err = f.targetMidi != null ? Math.abs((f.midi - f.targetMidi) * 100) : 0;
      ctx.strokeStyle = f.targetMidi == null ? '#22d3ee'
        : err <= 25 ? '#34d399' : err <= 50 ? '#fbbf24' : '#f87171';
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(px, py); ctx.stroke();
    } else {
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath(); ctx.arc(px, py, 2.6, 0, 7); ctx.fill();
    }
    prev = { x: px, y: py, t: f.t };
  }

  // 播放头
  const hx = w * HEAD;
  ctx.strokeStyle = 'rgba(255,255,255,.75)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, h); ctx.stroke();
  ctx.setLineDash([]);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCentMeter(f) {
  const cv = $('#centMeter');
  if (!cv || !cv.getBoundingClientRect().width) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);

  const pad = 16;
  const bw = w - pad * 2;
  const cy = h * 0.66;
  const bh = 12;
  const cx = v => pad + ((clamp(v, -100, 100) + 100) / 200) * bw;

  // 底槽分段
  const seg = (a, b, color) => {
    ctx.fillStyle = color;
    const x0 = cx(a), x1 = cx(b);
    ctx.fillRect(x0, cy - bh / 2, x1 - x0, bh);
  };
  seg(-100, -50, 'rgba(248,113,113,.5)');
  seg(-50, -25, 'rgba(251,191,36,.55)');
  seg(-25, 25, 'rgba(52,211,153,.75)');
  seg(25, 50, 'rgba(251,191,36,.55)');
  seg(50, 100, 'rgba(248,113,113,.5)');

  // 刻度
  ctx.font = '10px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,.45)';
  for (const v of [-100, -50, -25, 0, 25, 50, 100]) {
    ctx.fillRect(cx(v) - 0.5, cy + bh / 2, 1, 4);
    ctx.fillText(v === 0 ? '准' : (v > 0 ? '+' + v : v + ''), cx(v), cy + bh / 2 + 15);
  }

  // 指针
  const c = f.targetMidi != null && Number.isFinite(f.deltaCents) ? f.deltaCents : null;
  const on = f.freq > 0 && !f.silence;
  const px = cx(c ?? 0);
  ctx.fillStyle = !on ? 'rgba(255,255,255,.3)' : (Math.abs(c) <= 25 ? '#34d399' : Math.abs(c) <= 50 ? '#fbbf24' : '#f87171');
  ctx.beginPath();
  ctx.moveTo(px, cy - bh / 2 - 4);
  ctx.lineTo(px - 7, cy - bh / 2 - 15);
  ctx.lineTo(px + 7, cy - bh / 2 - 15);
  ctx.closePath();
  ctx.fill();

  // 标签
  ctx.textAlign = 'left';
  ctx.font = '11px system-ui';
  ctx.fillStyle = 'rgba(255,255,255,.6)';
  ctx.fillText(sessionMode === 'free' ? '音高走势（自由清唱无目标音）' : '相对目标音的偏差（音分）', pad, 14);
  ctx.textAlign = 'left';
}

function drawReportChart(rep) {
  const cv = $('#reportChart');
  if (!cv || !cv.getBoundingClientRect().width) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b1122';
  ctx.fillRect(0, 0, w, h);

  const S = rep.series;
  if (!S.length) return;
  const dur = Math.max(S[S.length - 1].t, 1);

  const midis = S.filter(p => p.midi != null).map(p => p.midi);
  let lo, hi;
  if (rep.mode !== 'free' && rep.noteErr?.length) {
    const tm = engine.target?.notes.map(n => n.midi) || [];
    lo = (tm.length ? Math.min(...tm) : Math.min(...midis)) - 3;
    hi = (tm.length ? Math.max(...tm) : Math.max(...midis)) + 3;
  } else {
    lo = (midis.length ? Math.min(...midis) : 60) - 3;
    hi = (midis.length ? Math.max(...midis) : 72) + 3;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 6) { lo = 57; hi = 75; }

  const padL = 34, padB = 20;
  const x = t => padL + (t / dur) * (w - padL - 6);
  const y = m => (h - padB) - ((m - lo) / (hi - lo)) * (h - padB - 8);

  // 网格
  ctx.font = '9px system-ui';
  for (let m = Math.ceil(lo); m <= hi; m++) {
    const isC = ((m % 12) + 12) % 12 === 0;
    ctx.strokeStyle = isC ? 'rgba(255,255,255,.11)' : 'rgba(255,255,255,.04)';
    ctx.beginPath(); ctx.moveTo(padL, y(m)); ctx.lineTo(w - 6, y(m)); ctx.stroke();
    if (isC) { ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.fillText(midiToName(m), 4, y(m) + 3); }
  }

  // 目标条（仅跟唱模式）
  if (rep.mode !== 'free' && engine.target) {
    ctx.fillStyle = 'rgba(139,92,246,.3)';
    for (const n of engine.target.notes) {
      const yy = y(n.midi);
      ctx.fillRect(x(n.start), yy - 3.5, Math.max(x(n.end) - x(n.start) - 1, 2), 7);
    }
  }

  // 实际曲线
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  let prev = null;
  for (const p of S) {
    if (p.midi == null) { prev = null; continue; }
    const px = x(p.t), py = y(p.midi);
    if (prev && p.t - prev.t < 0.3) {
      const err = p.cents != null ? Math.abs(p.cents) : 0;
      ctx.strokeStyle = p.cents == null ? '#22d3ee' : err <= 25 ? '#34d399' : err <= 50 ? '#fbbf24' : '#f87171';
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(px, py); ctx.stroke();
    } else {
      ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(px, py, 2, 0, 7); ctx.fill();
    }
    prev = { x: px, y: py, t: p.t };
  }

  // 时间轴
  ctx.fillStyle = 'rgba(255,255,255,.4)';
  ctx.textAlign = 'center';
  const step = dur > 40 ? 10 : dur > 15 ? 5 : 2;
  for (let t = 0; t <= dur; t += step) ctx.fillText(t + 's', x(t), h - 6);
  ctx.textAlign = 'left';
}

/* ══════════════ 报告渲染 ══════════════ */

function saveReport(rep) {
  const light = { ...rep };
  light.series = rep.series.filter((_, i) => i % 2 === 0).map(p => [
    +p.t.toFixed(2), p.midi == null ? null : +p.midi.toFixed(2),
    p.cents == null ? null : Math.round(p.cents), +p.rms.toFixed(3),
  ]);
  try { localStorage.setItem('amt.lastReport', JSON.stringify(light)); } catch { /* quota */ }
}

function loadReport() {
  try {
    const raw = localStorage.getItem('amt.lastReport');
    if (!raw) return null;
    const r = JSON.parse(raw);
    r.series = (r.series || []).map(a => ({ t: a[0], midi: a[1], cents: a[2], rms: a[3], hnr: NaN, centroid: NaN, target: null }));
    return r;
  } catch { return null; }
}

const SCORE_LABELS = [
  ['pitch', '音准'], ['rhythm', '节奏'], ['breath', '气息'],
  ['stability', '稳定'], ['resonance', '音色'],
];

function loadToneBaseline() {
  const v = parseFloat(localStorage.getItem('amt.toneBaseline') || 'NaN');
  return Number.isFinite(v) && v > 0 ? v : null;
}

function renderReport() {
  const rep = state.report;
  if (!rep) {
    $('#reportEmpty').classList.remove('hidden');
    $('#reportBody').classList.add('hidden');
    return;
  }
  $('#reportEmpty').classList.add('hidden');
  $('#reportBody').classList.remove('hidden');

  const s = rep.scores;
  const ring = $('#ringFg');
  const C = 2 * Math.PI * 52;
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - s.overall / 100);
  ring.style.stroke = s.overall >= 80 ? 'var(--ok)' : s.overall >= 60 ? 'var(--vio)' : 'var(--warn)';
  $('#scoreOverall').textContent = s.overall;

  $('#scoreBars').innerHTML = SCORE_LABELS
    .filter(([k]) => s[k] != null)
    .map(([k, label]) => `
      <div class="bar-row">
        <div class="lab"><span>${label}</span><b>${s[k]}</b></div>
        <div class="bar"><i style="width:${s[k]}%"></i></div>
      </div>`).join('');

  const modeName = { melody: '跟唱练习', free: '自由清唱', range: '音域测试' }[rep.mode] || rep.mode;
  $('#reportMeta').textContent = `${modeName} · ${rep.duration.toFixed(0)}s · ${rep.voicedRatio > 0 ? Math.round(rep.voicedRatio * 100) : 0}% 发声`;

  $('#findings').innerHTML = rep.findings.map(f => `
    <div class="find ${f.level}">
      <div class="fico">${LEVEL_ICON[f.level] || 'ℹ️'}</div>
      <div class="ftx"><b>${escapeHtml(f.title)}</b><span>${escapeHtml(f.text)}</span></div>
    </div>`).join('');

  const range = rep.range;
  $('#rangeRow').innerHTML = Number.isFinite(range.span) ? `
    <span class="range-pill">本次音域 <b>${range.low} ~ ${range.high}</b></span>
    <span class="range-pill">跨度 <b>${range.span.toFixed(1)}</b> 半音</span>
    <span class="range-pill">长音段 <b>${rep.segments}</b> 个</span>
    <span class="range-pill">HNR <b>${Number.isFinite(rep.breath.hnr) ? rep.breath.hnr.toFixed(1) + 'dB' : '--'}</b></span>
    <span class="range-pill">谱质心 <b>${Number.isFinite(rep.resonance.centroid) ? Math.round(rep.resonance.centroid) + 'Hz' : '--'}</b></span>${loadToneBaseline() ? `<span class="range-pill">个人基线 <b>${loadToneBaseline()}Hz</b></span>` : ''}` : '';

  $('#chartLegend').innerHTML = '<span style="color:#34d399">●准</span> <span style="color:#fbbf24">●偏</span> <span style="color:#f87171">●跑</span> <span style="color:#a78bfa">▬目标</span>';

  requestAnimationFrame(() => drawReportChart(rep));
  refreshAiPill();
}

/* ══════════════ AI 教师 ══════════════ */

function refreshAiPill() {
  const on = isConfigured();
  ['#aiPill', '#cfgPill'].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.textContent = on ? '已接入' : '未接入';
    el.classList.toggle('on', on);
  });
}

function addChat(role, html) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'me' : 'ai');
  div.innerHTML = html;
  $('#chatLog').appendChild(div);
  div.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return div;
}

async function askAI(question, outEl, messages) {
  if (!isConfigured()) {
    outEl.classList.add('error');
    outEl.textContent = '还没配置 AI 教师。去「设置」填 API 地址、模型名和 API Key（DeepSeek / 通义千问 / OpenAI 都支持）。';
    return null;
  }
  outEl.classList.remove('error');
  outEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  const btn = $('#btnAiReport');
  btn.disabled = true;
  try {
    const reply = await streamChat(messages, (d) => {
      if (outEl.querySelector('.typing')) outEl.textContent = '';
      outEl.textContent += d;
    });
    outEl.innerHTML = miniMd(reply);
    return reply;
  } catch (e) {
    outEl.classList.add('error');
    outEl.textContent = '⚠ ' + e.message;
    return null;
  } finally {
    btn.disabled = false;
  }
}

async function onAiReport() {
  const rep = state.report;
  if (!rep) return;
  const payload = toAiPayload(rep, { profile: loadProfile() });
  await askAI(null, $('#aiReport'), [{ role: 'user', content: buildReportMessage(payload, null).content }]);
}

async function onAiPlan() {
  const rep = state.report;
  if (!rep) return;
  const payload = toAiPayload(rep, { profile: loadProfile() });
  await askAI(null, $('#aiReport'), [{
    role: 'user',
    content: buildReportMessage(payload, '给我一份未来 21 天的练习计划，按天写清楚练什么、多久、达标线。').content,
  }]);
}

async function onChatSend() {
  const input = $('#chatInput');
  const q = input.value.trim();
  if (!q) return;
  if (!state.report) { toast('先做一次练习，AI 才能结合你的数据回答'); return; }
  input.value = '';
  addChat('user', escapeHtml(q));
  const holder = document.createElement('div');
  holder.className = 'msg ai';
  holder.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  $('#chatLog').appendChild(holder);
  holder.scrollIntoView({ block: 'nearest' });

  const payload = toAiPayload(state.report, { profile: loadProfile(), question: q });
  if (!isConfigured()) {
    holder.innerHTML = miniMd(localFallbackText(state.report));
    return;
  }
  try {
    const reply = await streamChat([{ role: 'user', content: JSON.stringify(payload, null, 2) }], (d) => {
      if (holder.querySelector('.typing')) holder.textContent = '';
      holder.textContent += d;
    });
    holder.innerHTML = miniMd(reply);
  } catch (e) {
    holder.innerHTML = `<span style="color:var(--bad)">⚠ ${escapeHtml(e.message)}</span>`;
  }
}

function loadProfile() {
  try { return JSON.parse(localStorage.getItem('amt.profile') || 'null'); } catch { return null; }
}

/* ══════════════ 课程 ══════════════ */

function renderCourses() {
  $('#courseList').innerHTML = COURSES.map((c, i) => `
    <div class="course ${i === 0 ? 'open' : ''}" data-id="${c.id}">
      <div class="course-head">
        <div class="cico">${c.icon}</div>
        <div class="ct"><b>${escapeHtml(c.title)}</b><span>${c.minutes} 分钟 · ${c.blocks.length} 节</span></div>
        <div class="arw">›</div>
      </div>
      <div class="course-body">
        ${c.blocks.map(b => `<div class="blk"><h4>${escapeHtml(b.h)}</h4><p>${miniMd(b.p)}</p></div>`).join('')}
      </div>
    </div>`).join('');

  $$('.course-head').forEach(h => {
    h.onclick = () => h.parentElement.classList.toggle('open');
  });
}

/* ══════════════ 设置 ══════════════ */

function renderSettings() {
  const s = loadSettings();
  $('#cfgPreset').innerHTML = PRESETS.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  const match = PRESETS.find(p => p.baseUrl && p.baseUrl === s.baseUrl);
  $('#cfgPreset').value = match ? match.id : 'custom';
  $('#cfgBase').value = s.baseUrl;
  $('#cfgModel').value = s.model;
  $('#cfgKey').value = s.apiKey;
  $('#cfgProxy').value = s.proxy || '';
  $('#silRange').value = state.silenceRms;
  $('#silVal').textContent = state.silenceRms;
  $('#ecoMode').checked = state.eco;
  const cnt = localStorage.getItem('amt.sessions') || '0';
  $('#storeInfo').textContent = `累计 ${cnt} 次练习`;
  refreshAiPill();
}

async function testAi() {
  const btn = $('#btnTestCfg');
  btn.disabled = true; btn.textContent = '测试中…';
  try {
    await streamChat([{ role: 'user', content: '只回复两个字：正常' }], () => {});
    toast('✅ 连通正常，AI 教师已可用');
  } catch (e) {
    toast('❌ ' + e.message, 5200);
  } finally {
    btn.disabled = false; btn.textContent = '测试连通';
  }
}

async function testMic() {
  const el = $('#micStatus');
  el.textContent = '检测中…';
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(st);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let peak = 0, n = 0;
    const iv = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let s = 0; for (const v of buf) s += v * v;
      peak = Math.max(peak, Math.sqrt(s / buf.length));
      if (++n > 40) {
        clearInterval(iv);
        st.getTracks().forEach(t => t.stop());
        ctx.close();
        el.textContent = peak > 0.01
          ? `✅ 正常（采样 ${ctx.sampleRate}Hz，峰值 ${(20 * Math.log10(peak)).toFixed(0)}dB）`
          : `⚠️ 能开但没收到声音，请对着手机说话试试`;
      }
    }, 50);
  } catch (e) {
    el.textContent = '❌ ' + (e.message || e.name);
  }
}

/* ══════════════ 初始化 ══════════════ */

function bind() {
  // tab 切换
  $$('.tab').forEach(t => t.onclick = () => goto(t.dataset.view));
  $$('[data-goto]').forEach(b => b.onclick = () => goto(b.dataset.goto));
  $('#btnAiStatus').onclick = () => goto(isConfigured() ? 'report' : 'settings');

  // 模式 chips
  $$('#modeChips .chip').forEach(c => {
    c.onclick = () => {
      state.mode = c.dataset.mode;
      $$('#modeChips .chip').forEach(x => x.classList.toggle('active', x === c));
      renderLessons();
    };
  });

  // 开始/演示
  $('#btnStart').onclick = () => beginSession(false);
  $('#btnDemo').onclick = () => beginSession(true);
  $('#btnStop').onclick = endSession;
  $('#btnSessionClose').onclick = () => {
    if (confirm('结束本次练习？未完成不会生成报告。')) {
      engine.stop();
      $('#sessionOverlay').classList.add('hidden');
    }
  };

  // 咬字
  $('#dictStart').onclick = startDictation;
  $('#dictPrev').onclick = () => { state.dictIdx = (state.dictIdx - 1 + DICTATION_LINES.length) % DICTATION_LINES.length; renderDict(); };
  $('#dictNext').onclick = () => { state.dictIdx = (state.dictIdx + 1) % DICTATION_LINES.length; renderDict(); };

  // AI
  $('#btnAiReport').onclick = onAiReport;
  $('#btnAiPlan').onclick = onAiPlan;
  $('#btnChatSend').onclick = onChatSend;
  $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') onChatSend(); });

  // 设置
  $('#cfgPreset').onchange = (e) => {
    const p = PRESETS.find(x => x.id === e.target.value);
    if (p && p.baseUrl) { $('#cfgBase').value = p.baseUrl; $('#cfgModel').value = p.model; }
  };
  $('#btnSaveCfg').onclick = () => {
    saveSettings({
      baseUrl: $('#cfgBase').value.trim(),
      model: $('#cfgModel').value.trim(),
      apiKey: $('#cfgKey').value.trim(),
      proxy: $('#cfgProxy').value.trim(),
    });
    refreshAiPill();
    toast('已保存到本机');
  };
  $('#btnTestCfg').onclick = testAi;
  $('#btnMicTest').onclick = testMic;
  $('#silRange').oninput = (e) => {
    state.silenceRms = parseFloat(e.target.value);
    $('#silVal').textContent = state.silenceRms;
    localStorage.setItem('amt.silence', state.silenceRms);
  };
  $('#ecoMode').onchange = (e) => {
    state.eco = e.target.checked;
    localStorage.setItem('amt.eco', state.eco ? '1' : '0');
  };
  $('#btnClear').onclick = () => {
    if (!confirm('清除本地保存的报告和 AI 配置？')) return;
    ['amt.lastReport', 'amt.sessions', 'amt.profile', 'amt.toneBaseline'].forEach(k => localStorage.removeItem(k));
    state.report = null;
    renderReport();
    renderSettings();
    toast('已清除');
  };

  window.addEventListener('resize', () => {
    if (state.report && $('#view-report').classList.contains('active')) drawReportChart(state.report);
  });

  // 屏幕常亮（练习时不息屏）
  let wakeLock = null;
  const reqWake = async () => {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && engine.running) reqWake();
  });
  $('#btnStart').addEventListener('click', reqWake);
}

function init() {
  state.silenceRms = parseFloat(localStorage.getItem('amt.silence') || '0.004');
  state.eco = localStorage.getItem('amt.eco') === '1';
  state.lesson = LESSONS[0];

  bind();
  renderLessons();
  renderCourses();
  renderSettings();

  state.report = loadReport();
  if (state.report) {
    const n = parseInt(localStorage.getItem('amt.sessions') || '0', 10);
    localStorage.setItem('amt.sessions', String(n + 1));
  }
  renderReport();

  $('#statusLine').textContent = isConfigured()
    ? '实时声学诊断 · AI 教师已接入'
    : '实时声学诊断 · 数据全部在本机处理';

  // PWA
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();

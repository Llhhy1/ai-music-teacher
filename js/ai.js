/**
 * ai.js — 接入大模型 API（OpenAI 兼容 /chat/completions，流式）
 *
 * 通义千问、DeepSeek、Moonshot、OpenAI 等都暴露 OpenAI 兼容接口，
 * 所以只需要一套实现，换个 baseUrl/model 就能切换。
 *
 * 注意：浏览器直连第三方 API 受 CORS 限制。若你用的服务商不允许浏览器调用，
 * 可在设置里填一个自己的转发地址（Cloudflare Worker / Vercel Edge 均可，几行代码）。
 */

const LS_KEY = 'ai_music_teacher.settings.v1';

export const PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', name: '通义千问 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'moonshot', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'custom', name: '自定义 / 本地模型', baseUrl: '', model: '' },
];

export function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { baseUrl: '', model: '', apiKey: '', proxy: '', ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { baseUrl: '', model: '', apiKey: '', proxy: '' };
}

export function saveSettings(s) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
  return s;
}

export function isConfigured() {
  const s = loadSettings();
  return Boolean(s.baseUrl && s.model && s.apiKey);
}

const SYSTEM_PROMPT = `你是一位经验丰富的中文流行声乐教师，长期做一对一教学，擅长把专业概念翻译成学生马上能做的动作。

你的工作方式：
1. 学生会给你一份**客观测量数据**（音高偏差/音分、谐噪比 HNR、谱质心、起唱延迟、颤音、音域等），这些数据是麦克风实测的，比学生的自我感觉更可信。以数据为准，不要否定数据。
2. 每条判断都要**落到一个具体的、可执行的动作**上（练什么、怎么练、练多久、什么算过关）。禁止说"多加练习""保持感觉""注意技巧"这类空话。
3. 一次只抓**最弱的 1–2 项**。同时指出五个问题等于没指出。
4. 用大白话解释术语：说"谱质心"时要顺带给出它对应的听感（闷 / 尖），说"谐噪比"时要说清是漏气还是结实。
5. 谱质心（音色明暗）**只在与该学生个人基线的比较中才有意义**：不同元音的谱质心天然相差数百 Hz，不存在"健康区间"。如果数据里给了个人基线或"偏闷/偏亮"的对比结论，就基于对比谈；没给基线就明说这项暂无参照，**不要自创 Hz 阈值**。
6. 不要过度鼓励，也不要打击。客观陈述差距，给出路径。
7. 涉及疼痛、嘶哑、唱不上去硬顶的情况，明确提醒停止并建议就医/找线下老师——你不能替代现场教学。

回答格式：
- 先用 2–3 句话说清"你现在最弱的是什么、为什么"
- 再给"接下来 3 天怎么练"，每天写明练哪一项、多少分钟、达标线是多少
- 最后一句给出下一次复测时应该看到的具体数字变化

语气：像一位严格但关心你的老师在课后给你发消息。用简体中文。`;

/**
 * 流式对话
 * @param {Array<{role:string,content:string}>} messages
 * @param {(delta:string)=>void} onDelta  增量回调
 * @returns {Promise<string>} 完整回复
 */
export async function streamChat(messages, onDelta) {
  const s = loadSettings();
  if (!s.baseUrl || !s.model || !s.apiKey) {
    throw new Error('尚未配置 AI 教师：请在「设置」里填写 API 地址、模型名和 API Key。');
  }

  const target = (s.proxy ? s.proxy.replace(/\/$/, '') + '/' : '') +
    s.baseUrl.replace(/\/$/, '') + '/chat/completions';

  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify({
        model: s.model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        stream: true,
        temperature: 0.6,
      }),
    });
  } catch (e) {
    throw new Error(
      '网络请求失败（大概率是浏览器 CORS 限制）。' +
      '请确认服务商允许浏览器直连；若不允许，在「设置 → 转发地址」填一个自己的代理，或改用支持直连的服务商。'
    );
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`API 返回 ${res.status}：${txt.slice(0, 300)}`);
  }

  // 流式读取
  const reader = res.body?.getReader();
  if (!reader) {
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    onDelta?.(text);
    return text;
  }

  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) { full += delta; onDelta?.(delta); }
      } catch { /* 忽略半包 */ }
    }
  }
  return full;
}

/** 把诊断报告 + 可选问题打包成一条用户消息 */
export function buildReportMessage(reportPayload, question) {
  let content = '这是我的一次实测练习数据：\n\n```json\n' +
    JSON.stringify(reportPayload, null, 2) + '\n```\n\n';
  content += question
    ? `我的具体问题是：${question}`
    : '请按你的格式给我诊断和接下来 3 天的练习计划。';
  return { role: 'user', content };
}

/** 无 API Key 时的本地兜底文字 */
export function localFallbackText(report) {
  const lines = report.findings.map(f => `· ${f.title}：${f.text}`);
  return [
    `**本地诊断（未接入 AI 教师）**  综合 ${report.scores.overall} 分`,
    '',
    ...lines,
    '',
    '—',
    '接入大模型后，我可以把这些数据转成人话的 3 天练习计划，还能随时追问。',
    '去「设置」填 API Key 即可开启。',
  ].join('\n');
}

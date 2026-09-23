# AI 歌手养成 · 手机端 AI 声乐教练

一个**可安装到手机的 PWA**：实时听你唱，客观诊断音准、气息、发声位置（音色明暗）、节奏和音域，再把数据交给大模型 API，由"AI 老师"用口语化的方式告诉你**接下来 3 天具体练什么**。

零依赖、零构建步骤：原生 ES Modules + Canvas，直接用静态服务器就能跑。

---

## 快速开始

```bash
npm start          # 等价于 python -m http.server 8080
# 打开 http://localhost:8080
```

> **为什么必须是 localhost 或 HTTPS？**
> 浏览器规定：`getUserMedia`（麦克风）只在**安全上下文**（HTTPS 或 localhost）下可用。
> 用 `http://局域网IP` 或 `http://文件路径` 打开时，麦克风按钮会直接失败。
> 手机上要真机测试，必须部署到 HTTPS（见下文），或让手机和电脑在同一网络后用 HTTPS 隧道。

没有麦克风也能体验：首页「演示模式」会合成一段"典型初学者"的演唱（掺了跑调、抢拍、漏气），完整走一遍分析 → 报告 → AI 点评流程。

### 部署到手机（HTTPS）

任选其一，全部免费：

| 方案 | 步骤 |
|---|---|
| **GitHub Pages** | 推到仓库 → Settings → Pages → 选 `main` 分支根目录 → 得到 `https://用户名.github.io/仓库名/` |
| **Vercel** | `npx vercel --prod`（框架选 **Other**，输出目录填 `.`） |
| **Netlify** | 拖拽整个文件夹到 app.netlify.com/drop |

手机浏览器打开 HTTPS 地址 → 菜单「添加到主屏幕」，即可像原生 App 一样全屏使用，且**离线可用**（Service Worker 缓存了整个应用外壳）。

---

## 它诊断什么

| 维度 | 指标 | 说明 |
|---|---|---|
| 音准 | 平均音高偏差（音分）、50 音分命中率、逐音偏差表、系统性偏高/偏低 | YIN 算法，实测误差 <0.1 音分 |
| 气息 | 谐噪比 HNR、高频能量占比 | HNR <12dB 基本可判定漏气 |
| 稳定 | 长音内音高游移 stddev、颤音 rate/extent | 区分"直音""自然颤音""喉部紧张抖动" |
| 音色/发声位置 | 功率谱质心 vs **个人基线** | 见下方"标定结论"，只做自比较 |
| 节奏 | 起唱延迟中位数（ms）、抢拍/拖拍、漏唱数 | 仅跟唱模式 |
| 音域 | 本次舒适区上下边界、跨度（半音） | 音域测试模式半音阶上下行 |

所有指标由 `js/metrics.js` 汇总成"老师听得出来"的结论文本，再连同结构化数据交给大模型。

### 为什么"发声位置"要跟自己的基线比

`test/calibrate.mjs` 用源-滤波器（共振峰）合成器做了标定，结论：

- **元音**使功率谱质心从 223Hz（衣 /i/）到 461Hz（啊 /a/）——差异最大，"位置好坏"的信号被它淹没；
- **谱倾斜**（白嗓 ↔ 亮）只让质心移动 403→466Hz，且方向正确但幅度小；
- **漏气**对功率质心的影响平均只有 0.7%（最大 1.6%），指望它测漏气是无效的——所以漏气用 HNR。

因此 app **不给"健康区间"这种绝对阈值**（旧版的 1000–1900Hz 是无依据的假设），而是：

1. 每次练习后用 EMA 更新你自己的音色基线（`amt.toneBaseline`）；
2. 报告只说"**比你平时偏闷 / 偏亮 / 一致**"；
3. 没有基线时不打音色分（`scores.resonance = null`），也不计入总分，只给一条"暂无基线"的说明；
4. AI 系统提示词里明确禁止大模型自创 Hz 阈值。

---

## 接入大模型（AI 老师）

设置页填三项即可：**接口地址、模型名、API Key**（Key 只存 localStorage，绝不上传）。

预设支持一套 OpenAI 兼容 `/chat/completions` 流式协议：

- DeepSeek（`https://api.deepseek.com/v1`）
- 通义千问 Qwen（DashScope 兼容模式）
- Moonshot / Kimi
- OpenAI
- 自定义任意兼容服务

**跨域被拦？** 填「转发地址」字段（任意 OpenAI 兼容中转），请求会发到转发地址而不是官方地址。流式输出，逐字显示。

没配 Key 也不影响使用：报告页有本地兜底结论文本（`localFallbackText`）。

---

## 测试

```bash
npm test           # 跑全部：dsp 31 项 + pipeline 59 项 = 90 项
node test/calibrate.mjs   # 重跑共振峰标定，打印阈值依据
```

- `test/dsp.test.mjs` — 音高检测精度（音分）、加噪鲁棒性、静音不误报、HNR 区分度、谱质心方向性；
- `test/pipeline.test.mjs` — 端到端：合成"初学者演唱" → 分析管线 → 报告，覆盖节拍换算、目标音高对齐、节奏匹配、打分与结论文本、无基线/有基线/基线偏移三种音色场景、静音与省电模式等边界；
- 分析逻辑全部在 `js/pipeline.js` + `js/metrics.js`，浏览器与 Node 跑同一份代码，所以测试结果对线上行为有直接代表性。

当前状态：**90 / 90 通过**。

---

## 目录结构

```
index.html              页面结构（单页 + tab 路由）
css/style.css           样式（含 PWA 视口适配）
manifest.webmanifest    PWA 清单（图标/全屏/竖屏）
sw.js                   Service Worker：外壳缓存，完全离线可用
js/
  pitch.js              YIN 基频检测 + 音名/唱名/简谱换算
  dsp.js                FFT、谱特征（功率加权 + 100–6000Hz 带限）、统计工具
  metrics.js            诊断引擎：分段、打分、结论文本、AI 载荷
  pipeline.js           分析管线（环形缓冲 → 逐帧特征 → Session），Node/浏览器通用
  lessons.js            8 个练习 + 5 篇课程 + 咬字句子，节拍 → 时间轴
  ai.js                 大模型接入：流式对话、系统提示词、本地兜底
  demo.js               演示音源（合成初学者演唱，无麦克风可体验）
  app.js                UI 控制器、Canvas 可视化、报告渲染、设置
  recorder-worklet.js   音频采集 Worklet（ScriptProcessor 兜底）
tools/gen-icons.mjs     零依赖 PNG 图标生成器（npm run icons）
test/                   90 项自动化测试 + 标定脚本
icons/                  192/512 + maskable 图标
```

---

## 隐私

- 音频**只在本机分析**，不录音、不上传；
- API Key、报告、个人基线全部存 localStorage；
- 「设置 → 清除本地数据」可一键抹掉。

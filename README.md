# dsh-stuck-monitor

> Passive dsh recorder: replays the main agent and all subagents on one timeline, flags where they got stuck, and writes an on-demand AI cause-and-effect review. README in Chinese.

DeepSeek Harness（dsh）插件：把一次对话里**主 agent 和它派出的所有 subagent** 做的每件事，按时间记录下来，在会话视图栏的"会话复盘"标签里用时间线回放。出问题的地方会标红点，需要时还能让 AI 写一份复盘，讲清楚前因后果。

它只记录，不干预：不会提醒、纠正或拦截 agent。

## 在哪里看

打开任意一个会话，标题下方的视图栏里有 **对话 / 轨迹 / 会话复盘**，点 **会话复盘**。显示的就是这个会话；会话进行中时每 5 秒刷新一次。

**会话总览页**

- **整体复盘**（AI）：发生了什么、最后结果、问题从哪一步开始、前因后果、各 subagent 起了什么作用
- **时间线**：主 agent 和每个 subagent 各一条泳道，色块是一段工作，红点是问题、黄点是外部阻拦、灰色斜纹是探查区段，虚线表示派出 subagent。点 subagent 的名字或色块进入它的页面
- **参与者**：每个 subagent 一条，按"在主 agent 的哪一段被派出"分组，同一批扇出排在一起；带运行状态、问题数、是否已复盘
- **主 agent 的经过**：分段列出，展开后可以看到每个时间点的事件；"派出 / 收到结果"旁边有跳转到对应 subagent 的链接

**subagent 页**（从参与者列表点进去；如果在 subagent 自己的会话里打开这个标签，会直接显示这一页）

- **来龙去脉**：几点由主 agent 在哪一段派出、接到的完整任务、几点以什么方式结束、交回了什么、交回到主 agent 的哪一段（都可以点击跳转）
- **它自己的复盘**（AI）
- **它自己的时间线**：每一根竖线是一个时间点（模型回复或工具调用），红色表示出错或有问题，点击会定位到对应事件；在空白处拖动可以框选一个时间段，下方的经过只显示这段时间
- **经过**：每一个事件的时间、内容、参数、结果或报错原文

**导出 Markdown**：总览页导出整个会话（包括全部 subagent），subagent 页只导出这一个；已经生成过的 AI 复盘会一起导出。文件名形如 `replay_2026-11-05_140200_session.md`。

## 自动标出的问题

标记只看“确实失败或卡住了”，不看“工作方式像不像在偷懒”。分三种：

**红点：问题**（agent 自己失败或卡住）

| 问题 | 怎么判断 |
|---|---|
| 原地重复 | 同一个调用连续 3 次以上，参数一样，**返回结果也一样**（结果在变，比如轮询状态，不算） |
| 来回打转 | 2–4 个调用组成的循环重复 3 轮以上，**每轮结果都一样**（改代码→跑测试、测试结果在变，不算） |
| 同一错误反复出现 | 同一个工具报同一类错误 3 次以上（行号、路径不同也算同一类） |
| 输出撞上限 | 模型回复写到一半被截断（结束方式为 max-tokens） |
| 没有正常结束 | subagent 以出错或拒绝执行结束 |

**黄点：外部阻拦**（不是 agent 的错，但它被挡住了）

| 情况 | 怎么判断 |
|---|---|
| 操作被拒绝 | 报错里出现 approval / rejected / denied / permission 等字样。常见原因是 skill 让它做了不被允许的事 |
| 模型请求失败 | 网络、限流或服务端错误 |
| 被取消 | 你手动停止，或上级 agent 取消了它 |

**灰色斜纹：工作方式记录**（不是问题，只是让你看出它这段时间在干什么）

| 记录 | 怎么判断 |
|---|---|
| 探查 | 连续 15 次以上只读调用（read、grep、glob、search、ls、web_* 等）。在时间线上显示为灰色斜纹区段 |
| 长思考 | 单次回复的推理超过 8000 tokens。真正撑爆的情况会被“输出撞上限”标出来 |

这些记录是否合理，要结合 agent 的任务来判断，比如只读的探查任务本来就该大量读取。AI 复盘会结合任务去看。

## AI 复盘

- 每个 subagent 可以单独生成复盘；整体复盘会使用已经生成过的 subagent 复盘，没生成过的使用压缩后的经过。这样会话再长也不会超出模型的输入上限，而且只为你想看的部分花钱。
- 只有点按钮时才会生成，不会自动调用，所以不会悄悄消耗额度。
- 默认使用这次对话本身用的模型，也可以在配置里指定别的模型。调用走的是 dsh 自己的模型服务，和 dsh 自动生成会话标题用的是同一条路。
- 生成结果保存在本地。会话之后如果还有新进展，复盘卡片上会提示"可重新生成"。

## 要求

- Node.js 24 或更高
- dsh 0.2.1-rc.5 上开发和测试

## 安装

先关掉正在运行的 dsh，然后在你的 dsh 项目目录里运行：

```bash
npx dsh plugin --profile web add https://github.com/jwang513/dsh-stuck-monitor
npx dsh web
```

`--profile web` 换成你实际用的 profile 名。已经装过的话，直接重启 `npx dsh web` 即可。

## 配置

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾加（Windows 上 `~` 就是 `C:\Users\<用户名>`）：

```yaml
- id: stuck-monitor
  name: 'dsh-stuck-monitor'
  config:
    outputDir: ''              # 记录目录，留空表示 ~/.dsh/stuck-monitor
    aiProvider: ''             # AI 复盘用的模型；留空表示用对话本身的模型
    aiModel: ''
    aiMaxTokens: 6000
    repeatThreshold: 3         # 下面这些是问题判断的阈值
    cycleMinRepeats: 2
    repeatedErrorThreshold: 3
    readOnlyStretch: 15
    reasoningWarnTokens: 8000
```

## 记录存在哪

`~/.dsh/stuck-monitor/sessions/` 下（可以用配置里的 `outputDir` 改），每次对话三个文件：

- `<id>.session.json`：完整的事件流、分段和问题
- `<id>.meta.json`：列表里显示的摘要
- `<id>.ai.json`：AI 复盘（生成过才有；整体复盘和各 subagent 的复盘都存在这里）

## 安全

面板读取数据的接口（`/stuck-monitor/session`、`/stuck-monitor/analyze`）都走 dsh 自己的登录和来源校验：不带 dsh 链接里的 token 会被拒绝（401），从别的网站发起的请求也会被拒绝（403）。

## 原理

| 用到的 dsh 事件 | 拿到的信息 |
|---|---|
| `agent/pre-step` | agent 收到的消息：用户的话、subagent 的任务、各种通知 |
| `agent/request` | agent 用的是哪个模型（AI 复盘默认用它） |
| `agent/assistant-stream` | 每次模型回复的正文、思考、token 用量、结束方式、耗时 |
| `tools/pre-execute` / `tools/post-execute` | 每次工具调用的开始时间、参数、结果或报错 |
| `agent/request-error` | 失败的模型请求 |
| `subagent/start` / `subagent/end` | 每个 subagent 何时开始、怎么结束（父 agent 从子 agent 会话头里的 `parentSession` 读出） |
| `agent/turn-stopping` | 主 agent 的一轮对话结束 |

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 监听事件，按对话汇总，每 5 秒把有变化的会话写盘 |
| `lib/session.js` | 把事件流整理成泳道、分段，并把问题定位到具体事件 |
| `lib/detect.js` | 问题判断规则（纯函数） |
| `lib/analyze.js` | 生成 AI 复盘：整理记录，调用模型，解析结果 |
| `lib/routes.js` | 给网页面板用的接口 |
| `client/client.js` | 视图栏里的"会话复盘"标签页，以及 Markdown 导出 |

## 已知限制

- 问题检测只看行为模式。"做的事和任务无关"这种语义上的偏离，要靠 AI 复盘来指出。
- 思考内容每次回复只保留开头和结尾各约 400 字，正文最多保留 1500 字。
- 记录每 5 秒写一次盘。dsh 重启后，同一个会话继续进行时会先读回已有记录再接着写；但 dsh 崩溃前最后几秒的记录可能丢失。
- 插件安装之前就结束的会话没有记录。
- 用户用 `/skill名` 直接调用的 skill 不算作工具调用，但用户那句话本身会出现在时间线里。

## 许可证

MIT

// AI review of a recorded conversation. Only runs when the user clicks a button
// in the panel, through dsh's own model service (ctx.llm) — the same way dsh's
// built-in session-title generator calls a model.
//
// Two scopes, so a long conversation never exceeds the model's input budget and
// you only pay for what you look at:
//   - one agent:  that agent's own events, plus who spawned it and what it handed back
//   - overall:    the main agent's events in full, and each subagent condensed —
//                 its own AI review when one exists, otherwise its segment summaries

import { truncate } from './detect.js'

const MAX_PROMPT_CHARS = 60_000

const SYSTEM = `你是一个 AI agent 运行过程的复盘分析员。你会收到一段运行记录：按时间顺序列出 agent 做的每一件事，以及程序自动检测出的问题位置。
你的任务是让人看懂"什么时候、哪个 agent、做了什么、哪里出了问题、前因后果是什么"。
要求：
- 只陈述记录里能看到的事实和由事实直接推出的因果，不要编造，不确定就说"记录里看不出"。
- 不要给改进建议，只解释发生了什么。
- 用简体中文，句子短，说人话。提到具体步骤时带上段落编号（如 S3）。
- 只输出一个 JSON 对象，不要 Markdown 代码块，不要其他文字。`

const REPORT_FORMAT = `"report": {
    "overview": "发生了什么（3-5 句）",
    "outcome": "最后结果：完成了吗？交付了什么或卡在哪里",
    "keyMoments": [ { "segment": "S3", "time": "07:19:12", "agent": "Subagent A", "what": "发生了什么" } ],
    "whereItWentWrong": { "segment": "S4", "description": "问题从哪一步开始、具体错在哪" },
    "causeChain": [ "因为 A……", "所以 B……", "结果 C……" ],
    "problems": { "P1": "这个被标出的问题实际是怎么回事（结合上下文）" }
  }`

const AGENT_FORMAT = `输出格式（严格 JSON）：
{
  "segments": { "S1": "这一段做了什么（一句话，30 字以内）" },
  ${REPORT_FORMAT}
}
segments 只写下面记录里出现的段落。没有问题时 whereItWentWrong 为 null，causeChain 写正常的推进过程。`

const OVERALL_FORMAT = `输出格式（严格 JSON）：
{
  "segments": { "S1": "主 agent 这一段做了什么（一句话，30 字以内）" },
  "agents": { "<agent 名称>": "这个 subagent 在整个会话里起了什么作用、结果如何（一句话）" },
  ${REPORT_FORMAT}
}
segments 只写主 agent 的段落。whereItWentWrong 指向问题最初发生的段落（可以是 subagent 的段落）。没有问题时 whereItWentWrong 为 null。`

/** Friendly names consistent with the panel: 主 agent, Subagent A, B, … */
export function agentNames(built) {
  const map = new Map()
  let n = 0
  for (const a of built.agents) map.set(a.id, a.role === 'main' ? '主 agent' : `Subagent ${String.fromCharCode(65 + n++)}`)
  return (id) => map.get(id) ?? `agent #${String(id).slice(-8)}`
}

export function describe(e, name, n = 300) {
  const mark = e.problems?.length ? ` ⚠${e.problems.join(',')}` : ''
  switch (e.kind) {
    case 'user': return `用户说：${truncate(e.text, n)}${mark}`
    case 'task': return `接到任务：${truncate(e.text, n)}${mark}`
    case 'message': return `收到消息（${e.from}）：${truncate(e.text, n)}${mark}`
    case 'step': {
      const bits = []
      if (e.reasoningChars) bits.push(`思考 ${e.reasoningChars} 字`)
      if (e.text) bits.push(`说：${truncate(e.text, n)}`)
      if (e.toolCalls?.length) bits.push(`决定调用 ${e.toolCalls.join('、')}`)
      if (e.finish && !['stop', 'tool-calls'].includes(e.finish)) bits.push(`回复结束方式：${e.finish}`)
      return `模型回复：${bits.join('；') || '（空）'}${mark}`
    }
    case 'tool': return `调用 ${e.name} ${truncate(e.args, Math.min(n, 200))} → ${e.isError ? `报错：${truncate(e.error, n)}` : `成功：${truncate(e.result, Math.min(n, 150)) || '（无输出）'}`}${mark}`
    case 'subagent-start': return `派出 ${name(e.child)}${mark}`
    case 'subagent-end': return `${name(e.child)} 结束（${e.stopReason}），最后说：${truncate(e.output, n)}${mark}`
    case 'request-error': return `模型请求失败：${truncate(e.message, n)}${mark}`
    case 'turn-end': return `这一轮对话结束${mark}`
    default: return `${e.kind}${mark}`
  }
}

function clock(t) {
  if (!t) return '?'
  return new Date(t).toTimeString().slice(0, 8)
}

function segmentLines(built, segments, name, budget) {
  const bySeq = new Map(built.events.map((e) => [e.seq, e]))
  const count = segments.reduce((n, s) => n + s.eventSeqs.length, 0)
  const per = Math.max(120, Math.floor(budget / Math.max(1, count)) - 40)
  const lines = []
  for (const s of segments) {
    lines.push('', `[${s.id}] ${name(s.agent)} ${clock(s.t0)}–${clock(s.t1)}${s.problems.length ? `  ⚠ ${s.problems.join(',')}` : ''}`)
    for (const q of s.eventSeqs) {
      const e = bySeq.get(q)
      if (e) lines.push(`  ${clock(e.t)} ${describe(e, name, per)}`)
    }
  }
  return lines
}

function problemLines(built, agentIds, name) {
  const tag = { error: '问题', external: '外部阻拦' }
  const ps = built.problems.filter((p) => agentIds.includes(p.agent))
  const ns = (built.notes ?? []).filter((n) => agentIds.includes(n.agent))
  const out = []
  if (ps.length) out.push('', '程序自动检测出的问题（"外部阻拦"表示是权限、网络或取消导致，不是 agent 自己的错）：',
    ...ps.map((p) => `- ${p.id} [${tag[p.level] ?? '问题'}·${p.label}] ${name(p.agent)}：${p.title}（位于 ${p.segments.join('、')}）`))
  if (ns.length) out.push('', '工作方式记录（不是问题；是否合理请结合 agent 的任务判断，例如只读的探查任务本来就该大量读取）：',
    ...ns.map((n) => `- ${n.id} [${n.label}] ${name(n.agent)}：${n.title}（位于 ${n.segments.join('、')}）`))
  return out
}

function clip(text) {
  return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}\n…（记录太长，后面截断）` : text
}

/** Digest for one agent: its own work, plus where it came from and what it handed back. */
export function buildAgentDigest(built, agentId) {
  const name = agentNames(built)
  const a = built.agents.find((x) => x.id === agentId)
  if (!a) throw new Error(`会话里没有这个 agent：${agentId}`)
  const lines = [`复盘对象：${name(a.id)}（${a.role === 'main' ? '主 agent' : 'subagent'}），结束原因 ${a.stopReason ?? '未结束'}，用过的 skill：${a.skills.join('、') || '无'}`]
  if (a.spawn) lines.push(`它由 ${name(a.spawn.agent)} 在 ${clock(a.spawn.t)}（${a.spawn.segment ?? '?'}）派出。`)
  if (a.task) lines.push(`它接到的任务：${truncate(a.task, 1500)}`)
  if (a.result) lines.push(`它在 ${clock(a.result.t)} 结束，交回给 ${name(a.result.agent)}（${a.result.segment ?? '?'}）的结果：${truncate(a.result.output, 600) || '（无）'}`)
  lines.push(...problemLines(built, [a.id], name))
  lines.push('', '它按时间顺序的记录（每段以 [S编号] 开头）：')
  lines.push(...segmentLines(built, built.segments.filter((s) => s.agent === a.id), name, MAX_PROMPT_CHARS - 4000))
  return clip(lines.join('\n'))
}

/** Digest for the whole conversation, with each subagent condensed. */
export function buildOverallDigest(built, agentReviews = {}) {
  const name = agentNames(built)
  const main = built.agents.find((a) => a.role === 'main') ?? built.agents[0]
  const lines = [`会话开始 ${clock(built.startedAt)}，结束 ${clock(built.endedAt)}。`, '参与的 agent：']
  for (const a of built.agents) {
    lines.push(`- ${name(a.id)}${a.spawn ? `（${clock(a.spawn.t)} 在 ${a.spawn.segment ?? '?'} 由 ${name(a.spawn.agent)} 派出）` : ''}，结束原因 ${a.stopReason ?? '未结束'}`)
  }
  lines.push(...problemLines(built, built.agents.map((a) => a.id), name))
  lines.push('', `一、${name(main.id)} 的完整记录（每段以 [S编号] 开头）：`)
  const subs = built.agents.filter((a) => a.id !== main.id)
  lines.push(...segmentLines(built, built.segments.filter((s) => s.agent === main.id), name, Math.floor(MAX_PROMPT_CHARS * (subs.length ? 0.5 : 0.9))))
  if (subs.length) {
    lines.push('', '二、各 subagent 的经过（已压缩）：')
    const per = Math.max(400, Math.floor((MAX_PROMPT_CHARS * 0.4) / subs.length))
    for (const a of subs) {
      const r = agentReviews[a.id]?.report
      lines.push('', `【${name(a.id)}】任务：${truncate(a.task, 200)}；结束原因 ${a.stopReason ?? '未结束'}`)
      if (r) {
        const bits = [r.overview && `经过：${r.overview}`, r.outcome && `结果：${r.outcome}`,
          r.whereItWentWrong && `问题起点：${r.whereItWentWrong.segment ?? ''} ${r.whereItWentWrong.description ?? ''}`,
          Array.isArray(r.causeChain) && r.causeChain.length && `前因后果：${r.causeChain.join(' → ')}`].filter(Boolean)
        lines.push(truncate(bits.join('\n'), per))
      } else {
        const segs = built.segments.filter((s) => s.agent === a.id)
        lines.push(truncate(segs.map((s) => `[${s.id}] ${clock(s.t0)} ${s.autoSummary}${s.problems.length ? ` ⚠${s.problems.join(',')}` : ''}`).join('\n'), per))
      }
    }
  }
  return clip(lines.join('\n'))
}

/**
 * Run one review through ctx.llm. Throws with a readable message on failure.
 * @param scope 'agent' | 'overall'
 * @returns {{ at, scope, agent?, route, segments, agents?, report, usage }}
 */
export async function runReview(llm, route, built, { scope = 'overall', agentId, agentReviews, maxTokens = 6000, timeoutMs = 180_000 } = {}) {
  if (!llm) throw new Error('dsh 的模型服务不可用')
  if (!route?.provider || !route?.model) throw new Error('不知道这次会话用的是哪个模型：请在配置里填写 aiProvider 和 aiModel')
  const digest = scope === 'agent' ? buildAgentDigest(built, agentId) : buildOverallDigest(built, agentReviews)
  const format = scope === 'agent' ? AGENT_FORMAT : OVERALL_FORMAT
  const signal = AbortSignal.timeout(timeoutMs)
  const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens }, signal, (controls, model) => {
    const least = model?.reasoning?.efforts?.[0]
    return least ? { ...controls, reasoningEffort: least.id } : controls
  })
  let text = ''
  let usage
  let finish
  for await (const chunk of call.stream({
    ...call.config,
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${format}\n\n下面是运行记录：\n\n${digest}` }] }],
    signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text ?? ''
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(`模型调用失败：${finish.failure?.message ?? finish.kind}`)
  const parsed = parseJson(text)
  if (!parsed) throw new Error(`模型没有返回可解析的 JSON${finish?.kind === 'max-tokens' ? '（输出被截断）' : ''}：${truncate(text, 200)}`)
  return {
    at: Date.now(),
    scope,
    ...(scope === 'agent' ? { agent: agentId } : {}),
    route,
    segments: parsed.segments && typeof parsed.segments === 'object' ? parsed.segments : {},
    ...(scope === 'overall' && parsed.agents && typeof parsed.agents === 'object' ? { agents: parsed.agents } : {}),
    report: parsed.report ?? {},
    usage,
  }
}

export function parseJson(text) {
  const s = String(text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

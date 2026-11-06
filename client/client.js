// Browser half of dsh-stuck-monitor: a "会话复盘" tab in the conversation view
// ring (next to 对话 / 轨迹).
//
//   conversation page:  overall AI review · swimlane timeline of every agent ·
//                       subagents grouped by where the main agent spawned them ·
//                       the main agent's own process
//   agent page:         where it came from and what it handed back · its own AI
//                       review · its own timeline (every event is a point; drag to
//                       zoom into a time range) · its process, segment by segment
//   both:               export as Markdown
//
// Opened inside a subagent's own conversation, the tab goes straight to that
// subagent's page. Hand-written in the factory format dsh's client module system
// loads (window.__ModuleLoader__.load), so the plugin needs no build step; only
// the shell's shared `react` module is required. Data comes from lib/routes.js.

window.__ModuleLoader__.load({ id: 'dsh-stuck-monitor', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

  const React = require('react')
  const { useState, useEffect, useMemo, useCallback, useRef } = React
  const h = React.createElement

  const NS = 'stuck-monitor'
  const API = {
    one: (id) => `stuck-monitor/session?id=${encodeURIComponent(id)}`,
    analyze: (id, agent) => `stuck-monitor/analyze?id=${encodeURIComponent(id)}${agent ? `&agent=${encodeURIComponent(agent)}` : ''}`,
  }
  const LIVE_MS = 120000
  const zh = { nav: '会话复盘' }
  const en = { nav: 'Replay' }

  // ---------- styles ----------
  const CSS = `
.dsm-root{height:100%;overflow-y:auto;box-sizing:border-box;padding:16px 24px 280px}
.dsm{max-width:var(--dsh-chat-content-width,1000px);margin:0 auto;position:relative;z-index:1;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.dsm h2{margin:0;font-size:18px;font-weight:600}
.dsm h3{margin:0;font-size:14px;font-weight:600}
.dsm-muted{color:var(--dsw-alias-label-tertiary)}
.dsm-sub{color:var(--dsw-alias-label-secondary)}
.dsm-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dsm-sp{flex:1}
.dsm-btn{font:inherit;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;border-radius:8px;padding:4px 12px;line-height:20px}
.dsm-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-btn:disabled{opacity:.55;cursor:default}
.dsm-btn.primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}
.dsm-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:8px}
.dsm-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.dsm-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;border-radius:999px;padding:1px 8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsm-chip.red{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dsm-chip.amber{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.dsm-chip.blue{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.dsm-chip.green{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.dsm-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.dsm-live{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block;animation:dsmPulse 1.4s infinite}
@keyframes dsmPulse{50%{opacity:.3}}
.dsm-link{cursor:pointer;color:var(--dsw-alias-state-business-primary);font-weight:500}
.dsm-link:hover{text-decoration:underline}
.dsm-ai{border-left:3px solid var(--dsw-alias-state-business-primary)}
.dsm-ai-sec{display:flex;flex-direction:column;gap:4px}
.dsm-label{font-size:12px;color:var(--dsw-alias-label-tertiary);font-weight:500}
.dsm-chain{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dsm-chain li{display:flex;gap:8px}
.dsm-chain li::before{content:'→';color:var(--dsw-alias-label-tertiary)}
.dsm-chain li:first-child::before{content:'●';font-size:9px;line-height:20px}
.dsm-wrong{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent)}
.dsm-grid{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}
.dsm-grid dt{color:var(--dsw-alias-label-tertiary)}
.dsm-grid dd{margin:0;min-width:0;word-break:break-word}
.dsm-moments{display:grid;grid-template-columns:max-content max-content 1fr;gap:3px 10px}
.dsm-tl{position:relative;padding-bottom:22px;user-select:none}
.dsm-lane{display:grid;grid-template-columns:150px 1fr;align-items:center;height:30px}
.dsm-lane-name{display:flex;align-items:center;gap:6px;font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding-right:8px;cursor:pointer}
.dsm-lane-name:hover{color:var(--dsw-alias-state-business-primary)}
.dsm-track{position:relative;height:100%;border-bottom:.5px dashed var(--dsw-alias-border-l1)}
.dsm-seg{position:absolute;top:7px;height:16px;border-radius:5px;cursor:pointer;min-width:5px;opacity:.75;box-sizing:border-box}
.dsm-seg:hover,.dsm-seg[data-sel=true]{opacity:1;outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
.dsm-seg[data-bad=true]{box-shadow:inset 0 0 0 2px var(--dsw-alias-state-error-primary)}
.dsm-pin{position:absolute;top:1px;width:10px;height:10px;margin-left:-5px;border-radius:50%;background:var(--dsw-alias-state-error-primary);border:2px solid var(--dsw-alias-bg-layer-1);cursor:pointer;z-index:2}
.dsm-tick-ev{position:absolute;top:9px;width:3px;height:12px;margin-left:-1px;border-radius:1px;cursor:pointer;z-index:1}
.dsm-tick-ev:hover{transform:scaleY(1.5)}
.dsm-spawn{position:absolute;width:0;border-left:1.5px dashed var(--dsw-alias-label-tertiary);pointer-events:none}
.dsm-axis{position:absolute;left:150px;right:0;bottom:0;height:18px}
.dsm-axis span{position:absolute;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsm-brush{position:absolute;top:0;bottom:0;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent);border:1px solid var(--dsw-alias-state-business-primary);pointer-events:none;z-index:3}
.dsm-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary);align-items:center}
.dsm-group{display:flex;flex-direction:column;gap:6px}
.dsm-group-head{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsm-agent-row{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;cursor:pointer;background:var(--dsw-alias-bg-layer-1)}
.dsm-agent-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-agent-row[data-bad=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent)}
.dsm-ellipsis{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsm-seg-item{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}
.dsm-seg-item[data-bad=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent)}
.dsm-seg-item[data-sel=true]{outline:2px solid var(--dsw-alias-state-business-primary)}
.dsm-seg-head{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:start;padding:9px 12px;cursor:pointer}
.dsm-seg-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-when{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;padding-top:1px}
.dsm-seg-body{border-top:.5px solid var(--dsw-alias-border-l1);padding:10px 12px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}
.dsm-problem{border:.5px solid var(--dsw-alias-state-error-primary);border-left-width:3px;border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.dsm-problem.external{border-color:var(--dsw-alias-state-warn-primary)}
.dsm-problem.note{border-color:var(--dsw-alias-border-l4)}
.dsm-band{position:absolute;top:3px;bottom:3px;border-radius:4px;background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-label-tertiary) 22%,transparent) 0 4px,transparent 4px 8px);pointer-events:auto;z-index:0}
.dsm-pin.external{background:var(--dsw-alias-state-warn-primary)}
.dsm-seg[data-warn=true]{box-shadow:inset 0 0 0 2px var(--dsw-alias-state-warn-primary)}
.dsm-seg-item[data-warn=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 60%,transparent)}
.dsm-ev{display:grid;grid-template-columns:64px 92px 1fr;gap:8px;padding:5px 0 5px 8px;border-left:2px solid transparent}
.dsm-ev[data-bad=true]{border-left-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,transparent)}
.dsm-ev[data-hl=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}
.dsm-ev[data-dim=true]{opacity:.35}
.dsm-ev-time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsm-ev-kind{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dsm-ev-main{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;white-space:pre-wrap}
.dsm-err{color:var(--dsw-alias-state-error-primary)}
.dsm-ok{color:var(--dsw-alias-state-success-primary)}
.dsm-pre{white-space:pre-wrap;word-break:break-word;margin:0}
.dsm-quote{white-space:pre-wrap;word-break:break-word;margin:0;padding:8px 10px;border-left:3px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);border-radius:4px;max-height:240px;overflow:auto}
.dsm-think{font-size:12px;color:var(--dsw-alias-label-tertiary);border-left:2px solid var(--dsw-alias-border-l3);padding-left:8px;white-space:pre-wrap;word-break:break-word}
.dsm details>summary{cursor:pointer}
`
  function installCss() {
    if (typeof document === 'undefined') return () => {}
    const id = 'dsh-stuck-monitor/panel.css'
    document.querySelector(`style[data-plugin-css="${id}"]`)?.remove()
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-stuck-monitor'
    tag.dataset.pluginCss = id
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => tag.remove()
  }

  // ---------- helpers ----------
  async function api(url, init) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' }, ...init })
    let body = null
    try { body = await r.json() } catch { /* empty */ }
    if (!r.ok) throw Object.assign(new Error(body?.error || `HTTP ${r.status}`), { status: r.status })
    return body
  }
  const pad = (n) => String(n).padStart(2, '0')
  const clock = (t) => { if (!t) return '?'; const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
  const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
  const dur = (ms) => {
    if (!(ms >= 0)) return '?'
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s} 秒`
    if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
    return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`
  }
  const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }
  const COLORS = ['var(--dsw-alias-state-business-primary)', '#8b5cf6', '#14b8a6', '#f59e0b', '#ec4899', '#0ea5e9', '#84cc16', '#f97316', '#6366f1', '#06b6d4']
  const STOP = { completed: '正常完成', 'max-tokens': '撞上 token 上限', error: '出错', aborted: '被取消', refusal: '拒绝执行' }
  // red = it failed or got stuck; amber = stopped from outside (denied, network, cancelled)
  const isExternal = (p) => p?.level === 'external'
  const lv = (p) => (isExternal(p) ? 'amber' : 'red')
  const errorsOf = (list) => list.filter((p) => !isExternal(p))
  const externalOf = (list) => list.filter(isExternal)
  /** problems (P…) and notes (N…) share one lookup */
  const byId = (session) => new Map([...session.problems, ...(session.notes ?? [])].map((p) => [p.id, p]))
  /** "2 处问题" / "1 处外部阻拦" chips */
  const countChips = (list) => [
    errorsOf(list).length > 0 && h('span', { key: 'e', className: 'dsm-chip red' }, `${errorsOf(list).length} 处问题`),
    externalOf(list).length > 0 && h('span', { key: 'x', className: 'dsm-chip amber' }, `${externalOf(list).length} 处外部阻拦`),
  ]
  const segEnd = (s) => Math.max(s.t1, s.t0)

  /** Friendly names (主 agent, Subagent A, B…) and colours, shared by every view and the export. */
  function agentInfo(session) {
    const map = new Map()
    let n = 0
    for (const a of session?.agents ?? []) {
      const i = map.size
      const letter = n < 26 ? String.fromCharCode(65 + n) : `#${n + 1}`
      map.set(a.id, { ...a, name: a.role === 'main' ? '主 agent' : `Subagent ${letter}`, color: COLORS[i % COLORS.length], lane: i })
      if (a.role !== 'main') n++
    }
    return map
  }

  // ---------- Markdown export ----------
  function eventMd(e, agents, problemsById) {
    const name = (id) => agents.get(id)?.name ?? id
    const tag = e.problems?.length ? `  ⚠ ${e.problems.map((p) => `${p} ${problemsById.get(p)?.label ?? ''}`).join('，')}` : ''
    const quote = (s) => String(s ?? '').trim().split('\n').map((l) => `  > ${l}`).join('\n')
    const head = `- \`${clock(e.t)}\` `
    switch (e.kind) {
      case 'user': return `${head}**用户**${tag}\n${quote(e.text)}`
      case 'task': return `${head}**接到任务**${tag}\n${quote(e.text)}`
      case 'message': return `${head}**收到消息**（${e.from}）${tag}\n${quote(e.text)}`
      case 'step': {
        const lines = [`${head}**模型回复**（${[e.usage && `输出 ${e.usage.outputTokens ?? '?'} tokens`, e.reasoningChars && `思考 ${e.reasoningChars} 字`, e.end && `用时 ${dur(e.end - e.t)}`, e.finish === 'max-tokens' && '**被截断：撞上输出上限**'].filter(Boolean).join('，')}）${tag}`]
        if (e.text) lines.push(quote(e.text))
        if (e.reasoning) lines.push(`  <details><summary>思考（开头与结尾）</summary>\n\n${quote(e.reasoning)}\n\n  </details>`)
        if (e.toolCalls?.length) lines.push(`  接下来调用：${e.toolCalls.join('、')}`)
        return lines.join('\n')
      }
      case 'tool': return `${head}**调用 ${e.name}**${tag}\n  - 参数：\`${String(e.args ?? '').replace(/`/g, "'")}\`\n  - ${e.isError ? `❌ 报错：${short(e.error, 600)}` : `✓ 结果：${short(e.result, 300) || '（没有输出）'}`}${e.end && e.end - e.t > 1500 ? `\n  - 用时 ${dur(e.end - e.t)}` : ''}`
      case 'subagent-start': return `${head}**派出 ${name(e.child)}**${tag}`
      case 'subagent-end': return `${head}**${name(e.child)} 结束**：${STOP[e.stopReason] ?? e.stopReason}${tag}${e.output ? `\n${quote(`它最后说：${e.output}`)}` : ''}`
      case 'request-error': return `${head}**模型请求失败**：${e.message}${tag}`
      case 'turn-end': return `${head}本轮对话结束`
      default: return `${head}${e.kind}`
    }
  }

  function reviewMd(review, level) {
    if (!review?.report) return ''
    const r = review.report
    const H = '#'.repeat(level)
    const out = [`${H} AI 复盘`, '', `> 生成于 ${day(review.at)} ${clock(review.at)}，模型 ${review.route?.model ?? '?'}`, '']
    if (r.overview) out.push('**发生了什么**', '', r.overview, '')
    if (r.outcome) out.push('**最后结果**', '', r.outcome, '')
    if (r.whereItWentWrong) out.push('**问题从这里开始**', '', `${r.whereItWentWrong.segment ? `${r.whereItWentWrong.segment}：` : ''}${r.whereItWentWrong.description ?? ''}`, '')
    if (r.causeChain?.length) out.push('**前因后果**', '', ...r.causeChain.map((c, i) => `${i + 1}. ${c}`), '')
    if (r.keyMoments?.length) out.push('**关键时刻**', '', '| 时间 | 段落 | agent | 发生了什么 |', '|---|---|---|---|', ...r.keyMoments.map((m) => `| ${m.time ?? ''} | ${m.segment ?? ''} | ${m.agent ?? ''} | ${String(m.what ?? '').replace(/\|/g, '\\|')} |`), '')
    if (review.agents && Object.keys(review.agents).length) out.push('**各 subagent 的作用**', '', ...Object.entries(review.agents).map(([k, v]) => `- ${k}：${v}`), '')
    return out.join('\n')
  }

  function agentSectionMd(session, ai, agents, agentId, level) {
    const a = agents.get(agentId)
    const H = '#'.repeat(level)
    const problemsById = byId(session)
    const bySeq = new Map(session.events.map((e) => [e.seq, e]))
    const review = ai?.agents?.[agentId] ?? (a.role === 'main' ? null : null)
    const segSummary = (s) => review?.segments?.[s.id] ?? (a.role === 'main' ? ai?.overall?.segments?.[s.id] : undefined) ?? s.autoSummary
    const out = [`${H} ${a.name}`, '']
    out.push(`- ID：\`${a.id}\``)
    out.push(`- 时间：${clock(a.startedAt)} → ${clock(a.endedAt)}（${dur((a.endedAt ?? session.endedAt) - a.startedAt)}）`)
    out.push(`- 结束原因：${STOP[a.stopReason] ?? a.stopReason ?? '未结束'}`)
    if (a.spawn) out.push(`- 来源：${clock(a.spawn.t)} 由 ${agents.get(a.spawn.agent)?.name ?? '?'} 在 ${a.spawn.segment ?? '?'} 派出`)
    if (a.result) out.push(`- 去向：${clock(a.result.t)} 结果交回 ${agents.get(a.result.agent)?.name ?? '?'}（${a.result.segment ?? '?'}）`)
    out.push(`- 用到的 skill：${a.skills?.length ? a.skills.join('、') : '无'}`)
    out.push(`- 工具调用 ${a.stats?.calls ?? 0} 次（报错 ${a.stats?.errors ?? 0}），模型请求 ${a.stats?.requests ?? 0} 次，输出 ${a.stats?.outputTokens ?? 0} tokens（推理 ${a.stats?.reasoningTokens ?? 0}）`, '')
    if (a.task) out.push('**任务**', '', String(a.task).split('\n').map((l) => `> ${l}`).join('\n'), '')
    if (review) out.push(reviewMd(review, level + 1), '')
    const probs = session.problems.filter((p) => p.agent === agentId)
    if (probs.length) {
      out.push(`${H}# 问题`, '', '| 编号 | 性质 | 类型 | 位置 | 说明 |', '|---|---|---|---|---|')
      for (const p of probs) out.push(`| ${p.id} | ${isExternal(p) ? '外部阻拦' : '问题'} | ${p.label} | ${p.segments.join('、')} | ${String(p.title).replace(/\|/g, '\\|')} |`)
      out.push('')
    }
    const notes = (session.notes ?? []).filter((n) => n.agent === agentId)
    if (notes.length) {
      out.push(`${H}# 工作方式记录（不是问题）`, '')
      for (const n of notes) out.push(`- ${n.id} ${n.label}：${n.title}，${clock(n.t0)}–${clock(n.t1)}（${n.segments.join('、')}）${n.evidence?.length ? `；${n.evidence.join('；')}` : ''}`)
      out.push('')
    }
    out.push(`${H}# 经过`, '')
    for (const s of session.segments.filter((x) => x.agent === agentId)) {
      out.push(`${H}## ${s.id}　${clock(s.t0)}–${clock(segEnd(s))}　${segSummary(s)}`, '')
      for (const pid of s.problems) {
        const p = problemsById.get(pid)
        if (p) out.push(`> ${isExternal(p) ? '⛔' : '⚠'} **${p.id} ${p.label}**：${p.title}${p.evidence?.length ? `\n> \n> ${p.evidence.join('；')}` : ''}`, '')
      }
      out.push(...s.eventSeqs.map((q) => bySeq.get(q)).filter(Boolean).sort((x, y) => x.t - y.t || x.seq - y.seq).map((e) => eventMd(e, agents, problemsById)), '')
    }
    return out.join('\n')
  }

  function sessionMd(session, ai) {
    const agents = agentInfo(session)
    const main = [...agents.values()].find((a) => a.role === 'main') ?? [...agents.values()][0]
    const subs = [...agents.values()].filter((a) => a.id !== main.id)
    const out = [`# 会话复盘：${session.title}`, '',
      `- 时间：${day(session.startedAt)} ${clock(session.startedAt)} → ${clock(session.endedAt)}（${dur(session.endedAt - session.startedAt)}）`,
      `- 参与者：主 agent${subs.length ? ` + ${subs.length} 个 subagent` : ''}`,
      `- 发现问题：${errorsOf(session.problems).length} 处${externalOf(session.problems).length ? `；外部阻拦 ${externalOf(session.problems).length} 处` : ''}`,
      `- 导出时间：${day(Date.now())} ${clock(Date.now())}`, '']
    if (ai?.overall) out.push(reviewMd(ai.overall, 2), '')
    if (subs.length) {
      out.push('## 参与者', '', '| 名称 | 派出于 | 时间 | 结束原因 | 问题 | 任务 |', '|---|---|---|---|---|---|')
      for (const a of subs) {
        const n = errorsOf(session.problems.filter((p) => p.agent === a.id)).length
        out.push(`| ${a.name} | ${a.spawn?.segment ?? '-'} | ${clock(a.startedAt)}–${clock(a.endedAt)} | ${STOP[a.stopReason] ?? a.stopReason ?? '未结束'} | ${n || '-'} | ${short(a.task, 60).replace(/\|/g, '\\|')} |`)
      }
      out.push('')
    }
    out.push(agentSectionMd(session, ai, agents, main.id, 2), '')
    for (const a of subs) out.push(agentSectionMd(session, ai, agents, a.id, 2), '')
    return out.join('\n')
  }

  function download(name, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // ASCII file name: some browsers drop non-ASCII download names
    a.download = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 100) + '.md'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // ---------- AI card ----------
  function AiCard({ title, review, running, error, onRun, stale, onJump, hint }) {
    if (!review) {
      return h('div', { className: 'dsm-card dsm-ai' },
        h('div', { className: 'dsm-bar' }, h('h3', null, title), h('span', { className: 'dsm-sp' }),
          h('button', { type: 'button', className: 'dsm-btn primary', disabled: running, onClick: onRun }, running ? '正在分析…' : `生成${title}`)),
        h('span', { className: 'dsm-muted' }, running ? '正在让模型读这段过程，通常需要半分钟到两分钟。' : hint),
        error && h('span', { className: 'dsm-err' }, `生成失败：${error}`))
    }
    const r = review.report ?? {}
    const seg = (id) => id && h('span', { className: 'dsm-link', onClick: () => onJump(id) }, id)
    return h('div', { className: 'dsm-card dsm-ai' },
      h('div', { className: 'dsm-bar' },
        h('h3', null, title),
        h('span', { className: 'dsm-muted', style: { fontSize: 12 } }, `${clock(review.at)} · ${review.route?.model ?? ''}`),
        stale && h('span', { className: 'dsm-chip amber' }, '之后又有新进展，可重新生成'),
        h('span', { className: 'dsm-sp' }),
        h('button', { type: 'button', className: 'dsm-btn', disabled: running, onClick: onRun }, running ? '正在分析…' : '重新生成')),
      error && h('span', { className: 'dsm-err' }, `生成失败：${error}`),
      r.overview && h('div', { className: 'dsm-ai-sec' }, h('span', { className: 'dsm-label' }, '发生了什么'), h('span', null, r.overview)),
      r.outcome && h('div', { className: 'dsm-ai-sec' }, h('span', { className: 'dsm-label' }, '最后结果'), h('span', null, r.outcome)),
      r.whereItWentWrong && h('div', { className: 'dsm-ai-sec dsm-wrong' },
        h('span', { className: 'dsm-label dsm-err' }, '问题从这里开始'),
        h('span', null, seg(r.whereItWentWrong.segment), r.whereItWentWrong.segment ? '　' : '', r.whereItWentWrong.description)),
      Array.isArray(r.causeChain) && r.causeChain.length > 0 && h('div', { className: 'dsm-ai-sec' },
        h('span', { className: 'dsm-label' }, '前因后果'),
        h('ul', { className: 'dsm-chain' }, r.causeChain.map((c, i) => h('li', { key: i }, h('span', null, c))))),
      review.agents && Object.keys(review.agents).length > 0 && h('details', null,
        h('summary', { className: 'dsm-label' }, `各 subagent 的作用（${Object.keys(review.agents).length}）`),
        h('dl', { className: 'dsm-grid', style: { marginTop: 6 } }, Object.entries(review.agents).flatMap(([k, v]) => [h('dt', { key: k + 'k' }, k), h('dd', { key: k + 'v' }, v)]))),
      Array.isArray(r.keyMoments) && r.keyMoments.length > 0 && h('details', null,
        h('summary', { className: 'dsm-label' }, `关键时刻（${r.keyMoments.length}）`),
        h('div', { className: 'dsm-moments', style: { marginTop: 6 } }, r.keyMoments.flatMap((m, i) => [
          h('span', { key: i + 't', className: 'dsm-muted' }, m.time ?? ''),
          h('span', { key: i + 's' }, seg(m.segment), ' ', h('span', { className: 'dsm-muted' }, m.agent ?? '')),
          h('span', { key: i + 'w' }, m.what ?? ''),
        ]))))
  }

  // ---------- timeline ----------
  /**
   * lanes: agents to draw. detail: also draw every event as a tick (agent page).
   * range / onRange: drag across a track to select a time window.
   */
  function Timeline({ session, agents, lanes, selected, onSegment, onLane, onEvent, detail, range, onRange }) {
    const own = new Set(lanes.map((a) => a.id))
    const evs = session.events.filter((e) => own.has(e.agent))
    const t0 = lanes.length === 1 ? Math.min(lanes[0].startedAt ?? session.startedAt, ...evs.map((e) => e.t)) : session.startedAt
    const t1 = Math.max(t0 + 1000, ...(lanes.length === 1 ? evs.map((e) => e.end ?? e.t) : [session.endedAt]))
    const frac = (t) => Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))
    const LANE = 30
    const problemsById = byId(session)
    const firstPin = new Map()
    for (const e of evs) for (const pid of e.problems ?? []) if (!firstPin.has(pid)) firstPin.set(pid, e)
    const segOf = new Map()
    for (const s of session.segments) for (const q of s.eventSeqs) segOf.set(q, s.id)
    const laneIndex = new Map(lanes.map((a, i) => [a.id, i]))
    const spawns = lanes.length > 1 ? evs.filter((e) => e.kind === 'subagent-start' && laneIndex.has(e.child)) : []
    const [drag, setDrag] = useState(null)
    const trackRef = useRef(null)
    const toTime = (clientX) => {
      const r = trackRef.current?.getBoundingClientRect()
      if (!r) return t0
      return t0 + Math.min(1, Math.max(0, (clientX - r.left - 150) / Math.max(1, r.width - 150))) * (t1 - t0)
    }
    const onDown = onRange && ((ev) => {
      if (ev.button !== 0 || ev.target.closest('.dsm-seg,.dsm-pin,.dsm-tick-ev,.dsm-lane-name')) return
      const a = toTime(ev.clientX)
      setDrag({ a, b: a })
    })
    const onMove = drag && ((ev) => setDrag((d) => ({ ...d, b: toTime(ev.clientX) })))
    const onUp = drag && (() => {
      const lo = Math.min(drag.a, drag.b), hi = Math.max(drag.a, drag.b)
      setDrag(null)
      if (hi - lo > (t1 - t0) / 200) onRange([lo, hi])
    })
    const brush = drag ? [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)] : range
    const tickColor = (e) => (e.problems?.some((pid) => isExternal(problemsById.get(pid)))
      ? 'var(--dsw-alias-state-warn-primary)'
      : e.problems?.length || e.isError || e.kind === 'request-error' || e.finish === 'max-tokens'
      ? 'var(--dsw-alias-state-error-primary)'
      : e.kind === 'tool' ? 'var(--dsw-alias-label-secondary)' : e.kind === 'step' ? 'var(--dsw-alias-border-l4)' : 'var(--dsw-alias-state-business-primary)')
    const evTitle = (e) => `${clock(e.t)}  ${e.kind === 'tool' ? `调用 ${e.name}${e.isError ? '（报错）' : ''}` : e.kind === 'step' ? '模型回复' : e.kind}`

    return h('div', { className: 'dsm-card' },
      h('div', { className: 'dsm-bar' },
        h('h3', null, '时间线'),
        h('span', { className: 'dsm-muted', style: { fontSize: 12 } }, `${clock(t0)} → ${clock(t1)}，共 ${dur(t1 - t0)}`),
        range && h('span', { className: 'dsm-chip blue' }, `已选 ${clock(range[0])}–${clock(range[1])}`),
        range && h('span', { className: 'dsm-link', style: { fontSize: 12 }, onClick: () => onRange(null) }, '清除选择'),
        h('span', { className: 'dsm-sp' }),
        h('div', { className: 'dsm-legend' },
          h('span', null, h('span', { className: 'dsm-dot', style: { background: 'var(--dsw-alias-state-error-primary)', marginRight: 4 } }), '问题'),
          h('span', null, h('span', { className: 'dsm-dot', style: { background: 'var(--dsw-alias-state-warn-primary)', marginRight: 4 } }), '外部阻拦'),
          h('span', null, h('span', { className: 'dsm-band', style: { position: 'static', display: 'inline-block', width: 16, height: 8, marginRight: 4, verticalAlign: 'middle' } }), '探查'),
          detail ? h('span', null, '竖线 = 一个时间点（回复 / 工具调用），点击定位') : h('span', null, '点 agent 名字进入它的页面'),
          onRange && h('span', null, '在空白处拖动可框选时间段'))),
      h('div', { className: 'dsm-tl', ref: trackRef, onMouseDown: onDown, onMouseMove: onMove, onMouseUp: onUp, onMouseLeave: onUp },
        lanes.map((a) => h('div', { key: a.id, className: 'dsm-lane' },
          h('div', { className: 'dsm-lane-name', title: `${a.name} · ${a.id}`, onClick: () => onLane?.(a.id) },
            h('span', { className: 'dsm-dot', style: { background: a.color } }),
            h('span', { className: 'dsm-ellipsis' }, a.name),
            a.stopReason && a.stopReason !== 'completed' && h('span', { className: 'dsm-chip red' }, a.stopReason === 'max-tokens' ? '被截断' : STOP[a.stopReason] ?? '!')),
          h('div', { className: 'dsm-track' },
            (session.notes ?? []).filter((n) => n.agent === a.id && n.type === 'explore').map((n) => h('div', {
              key: n.id, className: 'dsm-band',
              style: { left: `${frac(n.t0) * 100}%`, width: `${Math.max(0.4, (frac(n.t1) - frac(n.t0)) * 100)}%` },
              title: `${clock(n.t0)}–${clock(n.t1)}  ${n.label}：${n.title}（不是问题）`,
            })),
            session.segments.filter((s) => s.agent === a.id).map((s) => h('div', {
              key: s.id, className: 'dsm-seg',
              'data-bad': errorsOf(s.problems.map((pid) => problemsById.get(pid)).filter(Boolean)).length > 0,
              'data-warn': externalOf(s.problems.map((pid) => problemsById.get(pid)).filter(Boolean)).length > 0,
              'data-sel': selected === s.id,
              style: { left: `${frac(s.t0) * 100}%`, width: `${Math.max(0.6, (frac(segEnd(s)) - frac(s.t0)) * 100)}%`, background: a.color, opacity: detail ? 0.25 : undefined },
              title: `${s.id}  ${clock(s.t0)}–${clock(segEnd(s))}\n${s.autoSummary}`,
              onClick: () => onSegment(a.id, s.id),
            })),
            detail && evs.filter((e) => e.agent === a.id && (e.kind === 'tool' || e.kind === 'step' || e.kind === 'request-error' || e.kind.startsWith('subagent'))).map((e) => h('div', {
              key: `e${e.seq}`, className: 'dsm-tick-ev', style: { left: `${frac(e.t) * 100}%`, background: tickColor(e) },
              title: evTitle(e), onClick: () => onEvent?.(e),
            })),
            [...firstPin.entries()].filter(([, e]) => e.agent === a.id).map(([pid, e]) => {
              const p = problemsById.get(pid)
              return h('div', { key: pid, className: `dsm-pin ${isExternal(p) ? 'external' : ''}`, style: { left: `${frac(e.t) * 100}%` },
                title: `${clock(e.t)}  ${pid} ${p?.label}：${p?.title}`, onClick: () => (detail ? onEvent?.(e) : onSegment(a.id, segOf.get(e.seq))) })
            })))),
        spawns.map((e) => h('div', { key: `sp${e.seq}`, className: 'dsm-spawn',
          style: { left: `calc(150px + (100% - 150px) * ${frac(e.t)})`, top: Math.min(laneIndex.get(e.agent), laneIndex.get(e.child)) * LANE + LANE / 2, height: Math.abs(laneIndex.get(e.child) - laneIndex.get(e.agent)) * LANE } })),
        brush && h('div', { className: 'dsm-brush', style: { left: `calc(150px + (100% - 150px) * ${frac(brush[0])})`, width: `calc((100% - 150px) * ${frac(brush[1]) - frac(brush[0])})` } }),
        h('div', { className: 'dsm-axis' }, [0, 0.25, 0.5, 0.75, 1].map((f, i) => h('span', {
          key: i, style: { left: `${f * 100}%`, transform: i === 0 ? 'none' : i === 4 ? 'translateX(-100%)' : 'translateX(-50%)' },
        }, clock(t0 + f * (t1 - t0)))))))
  }

  // ---------- one event ----------
  function EventRow({ e, agents, problemsById, onOpenAgent, highlight, dim }) {
    const name = (id) => agents.get(id)?.name ?? `#${String(id).slice(-8)}`
    const evProblems = (e.problems ?? []).map((pid) => problemsById.get(pid)).filter(Boolean)
    const bad = errorsOf(evProblems).length > 0 || (e.isError && !externalOf(evProblems).length) || e.finish === 'max-tokens'
    const open = (id) => onOpenAgent && agents.has(id) && h('span', { className: 'dsm-link', onClick: () => onOpenAgent(id) }, ` 打开 ${name(id)} ›`)
    let kind = e.kind
    let body
    switch (e.kind) {
      case 'user': kind = '用户'; body = h('p', { className: 'dsm-pre' }, e.text); break
      case 'task': kind = '接到任务'; body = h('p', { className: 'dsm-pre' }, e.text); break
      case 'message': kind = '收到消息'; body = h('p', { className: 'dsm-pre dsm-sub' }, e.text); break
      case 'step':
        kind = '模型回复'
        body = h(React.Fragment, null,
          e.text ? h('p', { className: 'dsm-pre' }, e.text) : (!e.reasoningChars && h('span', { className: 'dsm-muted' }, '（没有正文）')),
          e.reasoning && h('details', null,
            h('summary', { className: 'dsm-muted', style: { fontSize: 12 } }, `思考了 ${e.reasoningChars} 字${e.usage?.reasoningTokens ? `（${e.usage.reasoningTokens} tokens）` : ''}，展开看开头和结尾`),
            h('div', { className: 'dsm-think' }, e.reasoning)),
          h('div', { className: 'dsm-bar dsm-muted', style: { fontSize: 12 } },
            e.toolCalls?.length > 0 && h('span', null, `接下来调用：${e.toolCalls.join('、')}`),
            e.usage && h('span', null, `输出 ${e.usage.outputTokens ?? '?'} tokens`),
            e.end && h('span', null, `用时 ${dur(e.end - e.t)}`),
            e.finish === 'max-tokens' && h('span', { className: 'dsm-chip red' }, '写到一半被截断（撞上输出上限）')))
        break
      case 'tool':
        kind = `调用 ${e.name}`
        body = h(React.Fragment, null,
          h('span', { className: 'dsm-mono dsm-sub' }, e.args),
          e.isError
            ? h('span', { className: 'dsm-mono dsm-err' }, `✗ ${e.error ?? '报错'}`)
            : h('span', { className: 'dsm-mono dsm-muted' }, h('span', { className: 'dsm-ok' }, '✓ '), short(e.result, 300) || '（没有输出）'),
          e.end && e.end - e.t > 1500 && h('span', { className: 'dsm-muted', style: { fontSize: 12 } }, `用时 ${dur(e.end - e.t)}`))
        break
      case 'subagent-start': kind = '派出'; body = h('span', null, `派出 ${name(e.child)}`, open(e.child)); break
      case 'subagent-end':
        kind = '收到结果'
        body = h(React.Fragment, null,
          h('span', null, `${name(e.child)} 结束：`, h('span', { className: e.stopReason === 'completed' ? 'dsm-ok' : 'dsm-err' }, STOP[e.stopReason] ?? e.stopReason), open(e.child)),
          e.output && h('p', { className: 'dsm-pre dsm-sub' }, `它最后说：${e.output}`))
        break
      case 'request-error': kind = '请求失败'; body = h('span', { className: 'dsm-err' }, e.message); break
      case 'turn-end': kind = '本轮结束'; body = h('span', { className: 'dsm-muted' }, '这一轮对话结束'); break
      default: body = h('span', null, JSON.stringify(e))
    }
    return h('div', { className: 'dsm-ev', 'data-bad': bad, 'data-hl': !!highlight, 'data-dim': !!dim, id: `dsm-ev-${e.seq}` },
      h('span', { className: 'dsm-ev-time' }, clock(e.t)),
      h('span', { className: 'dsm-ev-kind' }, kind),
      h('div', { className: 'dsm-ev-main' }, body,
        e.problems?.length > 0 && h('div', { className: 'dsm-bar' }, e.problems.map((pid) => {
          const p = problemsById.get(pid)
          return h('span', { key: pid, className: `dsm-chip ${lv(p)}` }, `${pid} ${p?.label ?? ''}`)
        }))))
  }

  // ---------- one segment ----------
  function SegmentItem({ seg, open, selected, onToggle, agents, summary, aiProblems, problemsById, bySeq, onOpenAgent, highlightSeq, range, innerRef }) {
    const a = agents.get(seg.agent)
    const problems = seg.problems.map((pid) => problemsById.get(pid)).filter(Boolean)
    const notes = (seg.notes ?? []).map((nid) => problemsById.get(nid)).filter(Boolean)
    const inRange = (e) => !range || ((e.end ?? e.t) >= range[0] && e.t <= range[1])
    return h('li', { className: 'dsm-seg-item', 'data-bad': errorsOf(problems).length > 0, 'data-warn': externalOf(problems).length > 0, 'data-sel': !!selected, ref: innerRef },
      h('div', { className: 'dsm-seg-head', onClick: onToggle },
        h('span', { className: 'dsm-when' }, `${seg.id}  ${clock(seg.t0)}`),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
          (problems.length > 0 || notes.length > 0) && h('div', { className: 'dsm-bar' },
            problems.map((p) => h('span', { key: p.id, className: `dsm-chip ${lv(p)}` }, `${isExternal(p) ? '⛔' : '⚠'} ${p.label}`)),
            notes.map((n) => h('span', { key: n.id, className: 'dsm-chip', title: `${n.title}（不是问题）` }, n.label))),
          summary ? h('span', null, summary) : h('span', { className: 'dsm-sub' }, seg.autoSummary)),
        h('span', { className: 'dsm-muted', style: { fontSize: 12, whiteSpace: 'nowrap' } }, `${dur(segEnd(seg) - seg.t0)} ${open ? '▴' : '▾'}`)),
      open && h('div', { className: 'dsm-seg-body' },
        notes.map((n) => h('div', { key: n.id, className: 'dsm-problem note' },
          h('div', { className: 'dsm-bar' }, h('span', { className: 'dsm-chip' }, `${n.id} ${n.label}`), h('span', null, n.title), h('span', { className: 'dsm-muted', style: { fontSize: 12 } }, '工作方式记录，不是问题')),
          n.evidence?.length > 0 && h('div', { className: 'dsm-mono dsm-sub' }, n.evidence.join('\n')))),
        problems.map((p) => h('div', { key: p.id, className: `dsm-problem ${isExternal(p) ? 'external' : ''}` },
          h('div', { className: 'dsm-bar' }, h('span', { className: `dsm-chip ${lv(p)}` }, `${p.id} ${p.label}`), h('strong', null, p.title)),
          p.evidence?.length > 0 && h('div', { className: 'dsm-mono dsm-sub' }, p.evidence.join('\n')),
          aiProblems?.[p.id] && h('span', null, h('span', { className: 'dsm-label' }, 'AI 解读：'), aiProblems[p.id]),
          p.segments?.length > 1 && h('span', { className: 'dsm-muted', style: { fontSize: 12 } }, `这个问题跨越了 ${p.segments.join('、')}`))),
        h('div', null, seg.eventSeqs.map((q) => bySeq.get(q)).filter(Boolean)
          .sort((x, y) => x.t - y.t || x.seq - y.seq)
          .map((e) => h(EventRow, { key: e.seq, e, agents, problemsById, onOpenAgent, highlight: e.seq === highlightSeq, dim: !inRange(e) })))))
  }

  /** Expand/collapse state + scroll-to for a list of segments. */
  function useSegments(initialOpen) {
    const [open, setOpen] = useState(() => new Set(initialOpen))
    const [selected, setSelected] = useState(null)
    const [highlight, setHighlight] = useState(null)
    const refs = useRef(new Map())
    const jump = useCallback((segId, seq) => {
      if (!segId) return
      setSelected(segId)
      setHighlight(seq ?? null)
      setOpen((prev) => new Set([...prev, segId]))
      setTimeout(() => {
        const el = (seq && document.getElementById(`dsm-ev-${seq}`)) || refs.current.get(segId)
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 60)
    }, [])
    const toggle = (id) => setOpen((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
    const ref = (id) => (el) => { if (el) refs.current.set(id, el); else refs.current.delete(id) }
    return { open, setOpen, selected, highlight, jump, toggle, ref }
  }

  // ---------- conversation page ----------
  function SessionPage({ data, agents, onOpenAgent, ai, aiState, runAi, initialSegment }) {
    const session = data.session
    const main = [...agents.values()].find((a) => a.role === 'main') ?? [...agents.values()][0]
    const subs = [...agents.values()].filter((a) => a.id !== main.id)
    const problemsById = useMemo(() => byId(session), [session])
    const bySeq = useMemo(() => new Map(session.events.map((e) => [e.seq, e])), [session])
    const mainSegs = session.segments.filter((s) => s.agent === main.id)
    const segs = useSegments(mainSegs.filter((s) => s.problems.length).map((s) => s.id).slice(0, 2))
    useEffect(() => { if (initialSegment) segs.jump(initialSegment) }, [initialSegment]) // eslint-disable-line
    // group subagents by the main-agent segment that spawned them (one group per fanout batch)
    const groups = []
    for (const a of subs) {
      const key = a.spawn?.segment ?? '?'
      let g = groups.find((x) => x.key === key)
      if (!g) groups.push(g = { key, t: a.spawn?.t ?? a.startedAt, agents: [] })
      g.agents.push(a)
    }
    const segClick = (agentId, segId) => (agentId === main.id ? segs.jump(segId) : onOpenAgent(agentId, segId))
    const live = Date.now() - session.updatedAt < LIVE_MS
    return h('div', { className: 'dsm' },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { className: 'dsm-bar' },
          live && h('span', { className: 'dsm-live', title: '进行中' }),
          h('h2', { style: { flex: '1 1 0', minWidth: 0 } }, session.title),
          h('button', { type: 'button', className: 'dsm-btn', onClick: () => download(`replay_${day(session.startedAt)}_${clock(session.startedAt).replace(/:/g, '')}_session`, sessionMd(session, ai)) }, '导出 Markdown')),
        h('div', { className: 'dsm-bar dsm-muted' },
          h('span', null, `${day(session.startedAt)} ${clock(session.startedAt)} → ${clock(session.endedAt)}（${dur(session.endedAt - session.startedAt)}）`),
          h('span', null, `主 agent${subs.length ? ` + ${subs.length} 个 subagent` : ''}`),
          errorsOf(session.problems).length ? h('span', { className: 'dsm-err' }, `${errorsOf(session.problems).length} 处问题`) : h('span', { className: 'dsm-ok' }, '没有发现问题'),
          externalOf(session.problems).length > 0 && h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, `${externalOf(session.problems).length} 处外部阻拦`))),
      h(AiCard, {
        title: '整体复盘', review: ai?.overall, running: aiState.running.has(''), error: aiState.errors[''], onRun: () => runAi(''),
        stale: !!ai?.overall?.forUpdatedAt && session.updatedAt > ai.overall.forUpdatedAt + 1000,
        onJump: (segId) => { const s = session.segments.find((x) => x.id === segId); if (s) segClick(s.agent, segId) },
        hint: subs.length
          ? `让模型串起整个会话的前因后果。已经生成过复盘的 subagent（${Object.keys(ai?.agents ?? {}).length}/${subs.length}）会用它们的复盘，其余的用压缩后的经过。会用到你当前的模型，消耗少量 API 额度。`
          : '让模型读完整个过程，写出问题从哪里开始、前因后果是什么。会用到你当前的模型，消耗少量 API 额度。',
      }),
      h(Timeline, { session, agents, lanes: [...agents.values()], selected: segs.selected, onSegment: segClick, onLane: (id) => (id === main.id ? null : onOpenAgent(id)) }),
      subs.length > 0 && h('div', { className: 'dsm-card' },
        h('h3', null, `参与者（主 agent + ${subs.length} 个 subagent）`),
        groups.map((g) => h('div', { key: g.key, className: 'dsm-group' },
          h('div', { className: 'dsm-group-head' },
            h('span', { className: 'dsm-link', onClick: () => segs.jump(g.key) }, g.key), ` ${clock(g.t)} 由主 agent 派出 · ${g.agents.length} 个`),
          g.agents.map((a) => {
            const probs = session.problems.filter((p) => p.agent === a.id)
            return h('div', { key: a.id, className: 'dsm-agent-row', 'data-bad': errorsOf(probs).length > 0, role: 'button', tabIndex: 0,
              onClick: () => onOpenAgent(a.id), onKeyDown: (ev) => { if (ev.key === 'Enter') onOpenAgent(a.id) } },
              h('span', { className: 'dsm-bar', style: { gap: 6, flexWrap: 'nowrap' } }, h('span', { className: 'dsm-dot', style: { background: a.color } }), h('strong', null, a.name)),
              h('span', { className: 'dsm-ellipsis dsm-sub', title: a.task }, short(a.task, 120) || '（没有记录到任务）'),
              h('span', { className: 'dsm-bar', style: { flexWrap: 'nowrap' } },
                h('span', { className: 'dsm-muted', style: { fontSize: 12 } }, `${clock(a.startedAt)} · ${dur((a.endedAt ?? session.endedAt) - a.startedAt)}`),
                !a.stopReason && h('span', { className: 'dsm-chip blue' }, '运行中'),
                a.stopReason && a.stopReason !== 'completed' && h('span', { className: 'dsm-chip red' }, STOP[a.stopReason] ?? a.stopReason),
                ...countChips(probs),
                ai?.agents?.[a.id] && h('span', { className: 'dsm-chip blue' }, '已复盘'),
                h('span', { className: 'dsm-muted' }, '›')))
          })))),
      h('div', { className: 'dsm-bar' },
        h('h3', null, `主 agent 的经过（${mainSegs.length} 段）`),
        h('span', { className: 'dsm-sp' }),
        h('button', { type: 'button', className: 'dsm-btn', onClick: () => segs.setOpen(new Set(mainSegs.map((s) => s.id))) }, '全部展开'),
        h('button', { type: 'button', className: 'dsm-btn', onClick: () => segs.setOpen(new Set()) }, '全部收起')),
      h('ul', { className: 'dsm-list' }, mainSegs.map((s) => h(SegmentItem, {
        key: s.id, seg: s, open: segs.open.has(s.id), selected: segs.selected === s.id, onToggle: () => segs.toggle(s.id), innerRef: segs.ref(s.id),
        agents, summary: ai?.overall?.segments?.[s.id], aiProblems: ai?.overall?.report?.problems, problemsById, bySeq, onOpenAgent,
      }))))
  }

  // ---------- agent page ----------
  function AgentPage({ data, agents, agentId, onBack, onOpenSession, onOpenAgent, ai, aiState, runAi, initialSegment }) {
    const session = data.session
    const a = agents.get(agentId)
    const problemsById = useMemo(() => byId(session), [session])
    const bySeq = useMemo(() => new Map(session.events.map((e) => [e.seq, e])), [session])
    const mySegs = session.segments.filter((s) => s.agent === agentId)
    const segs = useSegments(mySegs.filter((s) => s.problems.length).map((s) => s.id).slice(0, 2))
    const [range, setRange] = useState(null)
    useEffect(() => { if (initialSegment) segs.jump(initialSegment) }, [initialSegment, agentId]) // eslint-disable-line
    if (!a) return h('div', { className: 'dsm' }, h('p', { className: 'dsm-err' }, '这个 agent 不在记录里。'))
    const review = ai?.agents?.[agentId]
    const shown = range ? mySegs.filter((s) => segEnd(s) >= range[0] && s.t0 <= range[1]) : mySegs
    const parentName = a.spawn ? agents.get(a.spawn.agent)?.name : null
    const myProblems = session.problems.filter((p) => p.agent === agentId)
    return h('div', { className: 'dsm' },
      h('div', { className: 'dsm-bar' },
        onBack && h('button', { type: 'button', className: 'dsm-btn', onClick: onBack }, '← 会话总览'),
        h('span', { className: 'dsm-sp' }),
        h('button', { type: 'button', className: 'dsm-btn', onClick: () => download(`replay_${day(session.startedAt)}_${clock(session.startedAt).replace(/:/g, '')}_${a.role === 'main' ? 'main' : a.name.replace(/\s+/g, '')}`, `# 会话复盘：${session.title}\n\n${agentSectionMd(session, ai, agents, agentId, 2)}`) }, '导出 Markdown')),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { className: 'dsm-bar' },
          h('span', { className: 'dsm-dot', style: { background: a.color, width: 10, height: 10 } }),
          h('h2', null, a.name),
          !a.stopReason && h('span', { className: 'dsm-chip blue' }, '运行中'),
          a.stopReason && h('span', { className: `dsm-chip ${a.stopReason === 'completed' ? 'green' : 'red'}` }, STOP[a.stopReason] ?? a.stopReason),
          ...countChips(myProblems)),
        h('div', { className: 'dsm-bar dsm-muted' },
          h('span', null, `${clock(a.startedAt)} → ${clock(a.endedAt)}（${dur((a.endedAt ?? session.endedAt) - a.startedAt)}）`),
          h('span', null, `工具调用 ${a.stats?.calls ?? 0} 次（报错 ${a.stats?.errors ?? 0}）`),
          h('span', null, `输出 ${a.stats?.outputTokens ?? 0} tokens（推理 ${a.stats?.reasoningTokens ?? 0}）`),
          a.skills?.length > 0 && h('span', null, `skill：${a.skills.join('、')}`))),
      h('div', { className: 'dsm-card' },
        h('h3', null, '来龙去脉'),
        h('dl', { className: 'dsm-grid' },
          a.spawn && [h('dt', { key: 'sk' }, '从哪来'), h('dd', { key: 'sv' }, `${clock(a.spawn.t)} 由${parentName ?? '?'}在 `,
            h('span', { className: 'dsm-link', onClick: () => onOpenSession(a.spawn.segment) }, a.spawn.segment ?? '?'), ' 派出')],
          [h('dt', { key: 'tk' }, '任务'), h('dd', { key: 'tv' }, a.task ? h('pre', { className: 'dsm-quote' }, a.task) : h('span', { className: 'dsm-muted' }, '（没有记录到任务）'))],
          a.result && [h('dt', { key: 'rk' }, '交回什么'), h('dd', { key: 'rv' },
            h('span', null, `${clock(a.result.t)} 以「${STOP[a.result.stopReason] ?? a.result.stopReason}」结束，交回${agents.get(a.result.agent)?.name ?? '?'}的 `),
            h('span', { className: 'dsm-link', onClick: () => onOpenSession(a.result.segment) }, a.result.segment ?? '?'),
            a.result.output && h('pre', { className: 'dsm-quote', style: { marginTop: 6 } }, a.result.output))],
          !a.result && a.role !== 'main' && [h('dt', { key: 'nk' }, '交回什么'), h('dd', { key: 'nv', className: 'dsm-muted' }, '还没有结束')])),
      h(AiCard, {
        title: `${a.name} 的复盘`, review, running: aiState.running.has(agentId), error: aiState.errors[agentId], onRun: () => runAi(agentId),
        stale: !!review?.forUpdatedAt && session.updatedAt > review.forUpdatedAt + 1000 && !a.stopReason,
        onJump: (segId) => segs.jump(segId),
        hint: `只读 ${a.name} 自己的过程，加上它从哪来、交回了什么，写出它卡在哪里、前因后果是什么。会用到你当前的模型，消耗少量 API 额度。`,
      }),
      h(Timeline, {
        session, agents, lanes: [a], detail: true, selected: segs.selected, range, onRange: setRange,
        onSegment: (_, segId) => segs.jump(segId),
        onEvent: (e) => { const s = mySegs.find((x) => x.eventSeqs.includes(e.seq)); if (s) segs.jump(s.id, e.seq) },
      }),
      h('div', { className: 'dsm-bar' },
        h('h3', null, range ? `经过：${clock(range[0])}–${clock(range[1])} 之间（${shown.length}/${mySegs.length} 段）` : `经过（${mySegs.length} 段）`),
        h('span', { className: 'dsm-sp' }),
        h('button', { type: 'button', className: 'dsm-btn', onClick: () => segs.setOpen(new Set(shown.map((s) => s.id))) }, '全部展开'),
        h('button', { type: 'button', className: 'dsm-btn', onClick: () => segs.setOpen(new Set()) }, '全部收起')),
      h('ul', { className: 'dsm-list' }, shown.map((s) => h(SegmentItem, {
        key: s.id, seg: s, open: segs.open.has(s.id), selected: segs.selected === s.id, onToggle: () => segs.toggle(s.id), innerRef: segs.ref(s.id),
        agents, summary: review?.segments?.[s.id] ?? (a.role === 'main' ? ai?.overall?.segments?.[s.id] : undefined),
        aiProblems: review?.report?.problems, problemsById, bySeq, onOpenAgent, highlightSeq: segs.highlight, range,
      }))))
  }

  // ---------- the tab ----------
  function ReplayView(props) {
    const sessionId = props.sessionId
    const [state, setState] = useState({ loading: true })
    const [nav, setNav] = useState({ agent: null, segment: null, n: 0 })
    const [aiState, setAiState] = useState({ running: new Set(), errors: {} })
    const decided = useRef(false)
    const rootRef = useRef(null)
    // switching pages starts at the top (unless jumping to a segment)
    useEffect(() => {
      if (nav.segment) return
      // dsh may scroll an outer container instead of ours: reset every scrolled ancestor
      for (let el = rootRef.current; el && el !== document.body; el = el.parentElement) if (el.scrollTop) el.scrollTop = 0
    }, [nav.n]) // eslint-disable-line

    const load = useCallback(() => {
      if (!sessionId) return Promise.resolve()
      return api(API.one(sessionId))
        .then((d) => setState({ data: d }))
        .catch((e) => setState((p) => ({ ...p, loading: false, error: e.message, missing: e.status === 404 })))
    }, [sessionId])
    useEffect(() => { decided.current = false; setNav({ agent: null, segment: null, n: 0 }); setState({ loading: true }); load() }, [load])

    const data = state.data
    const session = data?.session
    const agents = useMemo(() => agentInfo(session), [session])
    // opened inside a subagent's own conversation → go straight to that subagent
    useEffect(() => {
      if (!data || decided.current) return
      decided.current = true
      const focus = agents.get(data.focus)
      if (focus && focus.role !== 'main') setNav({ agent: focus.id, segment: null, n: 1 })
    }, [data, agents])
    const live = !!session && Date.now() - session.updatedAt < LIVE_MS
    const polling = live || aiState.running.size > 0 || (state.missing && !data)
    useEffect(() => {
      if (!polling) return undefined
      const t = setInterval(load, 5000)
      return () => clearInterval(t)
    }, [polling, load])

    const runAi = (agentId) => {
      setAiState((s) => ({ running: new Set([...s.running, agentId]), errors: { ...s.errors, [agentId]: null } }))
      api(API.analyze(session.id, agentId), { method: 'POST' })
        .then((d) => setState((p) => ({ ...p, data: { ...p.data, ai: d.ai } })))
        .catch((e) => setAiState((s) => ({ ...s, errors: { ...s.errors, [agentId]: e.message } })))
        .finally(() => setAiState((s) => { const r = new Set(s.running); r.delete(agentId); return { ...s, running: r } }))
    }

    let body
    if (!sessionId) body = h('div', { className: 'dsm' }, h('p', { className: 'dsm-muted' }, '没有选中的会话。'))
    else if (!data && state.missing) body = h('div', { className: 'dsm' }, h('div', { className: 'dsm-card' },
      h('strong', null, '这个会话还没有记录'),
      h('span', { className: 'dsm-muted' }, 'agent 开始工作后，记录会在这里实时出现。插件安装之前就已经结束的会话不会有记录。')))
    else if (!data && state.error) body = h('div', { className: 'dsm' }, h('p', { className: 'dsm-err' }, `读取失败：${state.error}`))
    else if (!data) body = h('div', { className: 'dsm' }, h('p', { className: 'dsm-muted' }, '正在读取…'))
    else if (nav.agent) {
      body = h(AgentPage, {
        key: nav.agent + nav.n, data, agents, agentId: nav.agent, ai: data.ai, aiState, runAi, initialSegment: nav.segment,
        onBack: () => setNav({ agent: null, segment: null, n: nav.n + 1 }),
        onOpenSession: (segId) => setNav({ agent: null, segment: segId, n: nav.n + 1 }),
        onOpenAgent: (id, segId) => setNav({ agent: id, segment: segId ?? null, n: nav.n + 1 }),
      })
    } else {
      body = h(SessionPage, {
        key: 'session' + nav.n, data, agents, ai: data.ai, aiState, runAi, initialSegment: nav.segment,
        onOpenAgent: (id, segId) => setNav({ agent: id, segment: segId ?? null, n: nav.n + 1 }),
      })
    }
    return h('div', { className: 'dsm-root', ref: rootRef }, body)
  }

  // ---------- plugin ----------
  const name = 'dsh-stuck-monitor'
  const inject = ['slots', 'locale']

  function apply(ctx) {
    const t = ctx.locale.bind(NS)
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'stuck-monitor: dictionaries')
    ctx.effect(() => installCss(), 'stuck-monitor: styles')
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view',
      id: 'stuck-monitor-replay',
      order: 20,
      label: () => t('nav'),
      locale: NS,
      inject: (sessionId) => ({ t, sessionId }),
    }, ReplayView))
  }

  exports.name = name
  exports.inject = inject
  exports.apply = apply
  exports.sessionMarkdown = sessionMd
  return module.exports
} })

// Turns the raw recorded event stream of one conversation into what the
// timeline shows: agents (lanes), segments (chunks of work with a summary),
// problems (red = failed/stuck, amber = stopped from outside; markers on exact
// events) and notes (grey bands: exploring, long thinking — not problems).
// Pure: no dsh imports.

import { detect, truncate, TYPE_LABEL } from './detect.js'

const SEG_MAX_TOOLS = 6       // a segment closes after this many tool calls
const SEG_GAP_MS = 90_000     // ...or after this long a pause

/**
 * @param session { id, startedAt, updatedAt, events }
 * @param agents  Map<agentId, agentRecord>
 */
export function buildSession(session, agents, detectOptions) {
  const events = session.events
  const agentIds = [...new Set(events.map((e) => e.agent))]
  const agentList = agentIds.map((id) => agents.get(id)).filter(Boolean)
  // main agent first, then subagents in the order they appeared
  agentList.sort((a, b) => (a.role === 'main' ? -1 : b.role === 'main' ? 1 : 0))

  // ---- problems, located on exact events --------------------------------
  const problems = []
  const problemsBySeq = new Map()
  const notes = []
  const notesBySeq = new Map()
  for (const a of agentList) {
    const callSeq = new Map(a.calls.map((c) => [c.index, c.seq]))
    const stepSeq = new Map(a.steps.map((s) => [`${s.turn}.${s.step}`, s.seq]))
    for (const e of a.requestErrors) stepSeq.set(`${e.turn}.${e.step}`, e.seq)
    const lastSeq = [...events].reverse().find((e) => e.agent === a.id)?.seq
    for (const f of detect(a, detectOptions)) {
      let seqs = [
        ...f.refs.calls.map((i) => callSeq.get(i)),
        ...f.refs.steps.map((k) => stepSeq.get(k)),
      ].filter((s) => s !== undefined)
      if (!seqs.length && lastSeq !== undefined) seqs = [lastSeq]
      const isNote = f.level === 'note'
      const list = isNote ? notes : problems
      const p = {
        id: `${isNote ? 'N' : 'P'}${list.length + 1}`,
        agent: a.id,
        type: f.type,
        label: f.label,
        level: f.level,
        severity: f.severity,
        title: f.title,
        evidence: f.evidence,
        eventSeqs: [...new Set(seqs)].sort((x, y) => x - y),
      }
      list.push(p)
      const index = isNote ? notesBySeq : problemsBySeq
      for (const s of p.eventSeqs) {
        const ids = index.get(s) ?? []
        ids.push(p.id)
        index.set(s, ids)
      }
    }
  }

  // ---- segments, per agent, in time order --------------------------------
  const segments = []
  for (const a of agentList) {
    let cur = null
    const close = () => {
      if (!cur) return
      finishSegment(cur, problemsBySeq, notesBySeq)
      segments.push(cur)
      cur = null
    }
    for (const e of events) {
      if (e.agent !== a.id) continue
      // a new instruction / incoming notice starts a new phase; so do long runs and long pauses
      const opensNew = e.kind === 'user' || e.kind === 'task' ||
        (cur && e.kind === 'message' && cur.events.some((x) => x.kind !== 'message' && x.kind !== 'subagent-end')) ||
        (cur && (cur.tools >= SEG_MAX_TOOLS || e.t - cur.t1 > SEG_GAP_MS))
      if (!cur || opensNew) {
        close()
        cur = { agent: a.id, t0: e.t, t1: e.end ?? e.t, events: [], tools: 0 }
      }
      cur.events.push(e)
      cur.t1 = Math.max(cur.t1, e.end ?? e.t)
      if (e.kind === 'tool') cur.tools += 1
      if (e.kind === 'turn-end') close()
    }
    close()
  }
  segments.sort((x, y) => x.t0 - y.t0 || x.events[0].seq - y.events[0].seq)
  segments.forEach((s, i) => { s.id = `S${i + 1}` })
  const bySeqT = new Map(events.map((e) => [e.seq, e]))
  for (const n of notes) {
    const evs = n.eventSeqs.map((q) => bySeqT.get(q)).filter(Boolean)
    n.t0 = Math.min(...evs.map((e) => e.t))
    n.t1 = Math.max(...evs.map((e) => e.end ?? e.t))
  }
  for (const p of [...problems, ...notes]) {
    p.segments = segments.filter((s) => s.eventSeqs.some((q) => p.eventSeqs.includes(q))).map((s) => s.id)
  }

  // where each subagent was spawned and where its result came back (segment + event)
  const segOf = new Map()
  for (const sg of segments) for (const q of sg.eventSeqs) segOf.set(q, sg.id)
  const links = new Map()
  for (const e of events) {
    if (e.kind !== 'subagent-start' && e.kind !== 'subagent-end') continue
    const l = links.get(e.child) ?? {}
    const at = { seq: e.seq, t: e.t, agent: e.agent, segment: segOf.get(e.seq) }
    if (e.kind === 'subagent-start') l.spawn ??= at
    else l.result = { ...at, stopReason: e.stopReason, output: e.output }
    links.set(e.child, l)
  }

  const firstUser = events.find((e) => e.kind === 'user')
  const lastT = events.reduce((m, e) => Math.max(m, e.end ?? e.t), session.startedAt)
  return {
    version: 3,
    id: session.id,
    title: truncate(firstUser?.text ?? '(没有用户消息)', 80),
    startedAt: session.startedAt,
    endedAt: lastT,
    updatedAt: session.updatedAt,
    agents: agentList.map((a) => ({
      id: a.id,
      role: a.role,
      parentId: a.parentId,
      provider: a.provider,
      route: a.route,
      task: truncate(a.task, 600),
      skills: [...new Set(a.skills)],
      stopReason: a.stopReason,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      spawn: links.get(a.id)?.spawn,
      result: links.get(a.id)?.result,
      stats: {
        calls: a.calls.length,
        errors: a.calls.filter((c) => c.isError).length,
        requests: a.steps.length,
        outputTokens: a.steps.reduce((n, s) => n + (s.usage?.outputTokens ?? 0), 0),
        reasoningTokens: a.steps.reduce((n, s) => n + (s.usage?.reasoningTokens ?? 0), 0),
      },
    })),
    problems,
    notes,
    segments: segments.map(({ events: evs, tools, ...rest }) => rest),
    events: events.map((e) => (problemsBySeq.has(e.seq) ? { ...e, problems: problemsBySeq.get(e.seq) } : e)),
  }
}

/** Short headline for a session list. */
export function sessionMeta(built, ai) {
  const levels = { error: 0, external: 0 }
  for (const p of built.problems) levels[p.level] = (levels[p.level] ?? 0) + 1
  return {
    id: built.id,
    title: built.title,
    startedAt: built.startedAt,
    endedAt: built.endedAt,
    updatedAt: built.updatedAt,
    agents: built.agents.length,
    agentIds: built.agents.map((a) => a.id),
    subagents: built.agents.filter((a) => a.role === 'subagent').length,
    events: built.events.length,
    problems: built.problems.map((p) => ({ type: p.type, label: p.label, level: p.level })),
    levels,
    ai: ai ? { at: ai.overall?.at ?? ai.at ?? null, agents: Object.keys(ai.agents ?? {}).length } : null,
  }
}

function finishSegment(seg, problemsBySeq, notesBySeq) {
  seg.eventSeqs = seg.events.map((e) => e.seq)
  seg.problems = [...new Set(seg.eventSeqs.flatMap((s) => problemsBySeq.get(s) ?? []))]
  seg.notes = [...new Set(seg.eventSeqs.flatMap((s) => notesBySeq.get(s) ?? []))]
  seg.autoSummary = autoSummary(seg.events)
}

/** What the agent itself said it was doing, else a tally of what it did. */
function autoSummary(events) {
  const parts = []
  const first = events[0]
  if (first.kind === 'user') parts.push(`用户：${truncate(first.text, 60)}`)
  if (first.kind === 'task') parts.push(`接到任务：${truncate(first.text, 60)}`)
  const said = events.find((e) => e.kind === 'step' && e.text?.trim())
  if (said) parts.push(`“${truncate(firstSentence(said.text), 70)}”`)
  const tally = {}
  let errors = 0
  for (const e of events) {
    if (e.kind === 'tool') { tally[e.name] = (tally[e.name] ?? 0) + 1; if (e.isError) errors += 1 }
    if (e.kind === 'subagent-start') parts.push('派出一个 subagent')
    if (e.kind === 'subagent-end') parts.push(`subagent 结束（${e.stopReason}）`)
  }
  const t = Object.entries(tally).map(([n, k]) => (k > 1 ? `${n}×${k}` : n)).join('、')
  if (t) parts.push(`调用 ${t}${errors ? `，${errors} 次报错` : ''}`)
  if (!parts.length) parts.push(events.some((e) => e.kind === 'step') ? '思考中' : TYPE_LABEL[first.kind] ?? first.kind)
  return parts.join('；')
}

function firstSentence(text) {
  const s = String(text).trim()
  const m = s.match(/^.{8,}?[。！？.!?\n]/s)
  return m ? m[0] : s
}

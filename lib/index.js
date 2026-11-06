// dsh-stuck-monitor — a passive flight recorder for a whole conversation:
// the main agent and every subagent it spawns, on one timeline.
//
// It only listens: every waterfall listener returns next() unchanged and every
// handler is wrapped so a monitor bug cannot break an agent.
//
// Events used (verified against @deepseek-ai/* 0.2.1-rc.5 typings):
//   agent/pre-step          messages an agent receives (user prompt, subagent task, notices)
//   agent/request           which provider/model an agent uses (for the AI summary later)
//   agent/assistant-stream  each model reply: text, reasoning, usage, finish reason, timing
//   tools/pre-execute       when a tool call starts
//   tools/post-execute      how it ended: arguments, result or error
//   agent/request-error     failed model requests
//   agent/turn-stopping     end of a main-agent turn
//   subagent/start|end      who spawned whom, and how each subagent ended

import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, callKey, truncate } from './detect.js'
import { buildSession, sessionMeta } from './session.js'
import { mountRoutes, sessionFile } from './routes.js'

export const name = 'stuck-monitor'

const MAX_EVENTS = 6000
const FLUSH_MS = 5000
const TEXT_KEEP = 1500
const REASONING_HEAD = 400
const REASONING_TAIL = 400
const ARGS_KEEP = 300
const RESULT_KEEP = 400
const STARTED_RE = /started subagent ([A-Za-z0-9][A-Za-z0-9._:-]{7,199})/g

export function apply(ctx, config = {}) {
  const log = ctx.logger('stuck-monitor')
  const outputDir = config.outputDir || join(homedir(), '.dsh', 'stuck-monitor')
  const sessionsDir = join(outputDir, 'sessions')
  const detectOptions = { ...DEFAULTS, ...pick(config, Object.keys(DEFAULTS)) }

  /** agentId -> agent record */
  const agents = new Map()
  /** child agentId -> { parentId, provider } */
  const parents = new Map()
  /** root (main) agentId -> session */
  const sessions = new Map()
  /** attemptId -> in-flight step */
  const attempts = new Map()
  /** callId -> start time */
  const callStarts = new Map()

  /** child ids whose "派出" event is already on the parent's lane */
  const announced = new Set()

  /** The conversation an agent belongs to: walk up to the top parent (never undefined). */
  const rootOf = (id) => {
    let cur = id
    for (let i = 0; i < 20; i++) {
      const up = parents.get(cur)?.parentId
      if (!up || up === cur) break
      cur = up
    }
    return cur
  }

  /** Rebuild an agent record's references (calls / steps / errors) from its events. */
  function refsFrom(events, agentId) {
    const own = events.filter((e) => e.agent === agentId)
    return {
      calls: own.filter((e) => e.kind === 'tool').map((e) => ({
        seq: e.seq, index: e.index, name: e.name, key: e.key ?? callKey(e.name, e.args),
        out: e.out ?? (e.isError ? `E:${e.error ?? ''}` : `R:${e.result ?? ''}`),
        argsPreview: truncate(e.args, 160), isError: !!e.isError, error: e.error,
      })),
      steps: own.filter((e) => e.kind === 'step').map((e) => ({
        seq: e.seq, turn: e.turn, step: e.step, finish: e.finish, usage: e.usage,
        reasoningChars: e.reasoningChars ?? 0, textChars: e.textChars ?? 0, toolArgChars: e.toolArgChars ?? 0,
      })),
      requestErrors: own.filter((e) => e.kind === 'request-error').map((e) => ({ seq: e.seq, turn: e.turn, step: e.step, message: e.message })),
      callCounter: own.reduce((m, e) => (e.kind === 'tool' ? Math.max(m, e.index ?? 0) : m), 0),
    }
  }

  /**
   * After a dsh restart the in-memory record is empty. The first time a
   * conversation is touched, read what was already written for it and continue
   * from there, instead of starting blank and overwriting the file.
   */
  const loaded = new Set()
  function restore(rootId) {
    if (loaded.has(rootId)) return
    loaded.add(rootId)
    let saved
    try {
      saved = JSON.parse(readFileSync(sessionFile(sessionsDir, rootId, 'session'), 'utf8'))
    } catch {
      return // nothing recorded yet (or unreadable): start fresh
    }
    if (!Array.isArray(saved?.events) || !Array.isArray(saved?.agents)) return
    const s = { id: rootId, startedAt: saved.startedAt ?? Date.now(), updatedAt: saved.updatedAt ?? Date.now(),
      events: saved.events.map(({ problems, ...e }) => e), seq: 0, dirty: false }
    s.seq = s.events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0)
    sessions.set(rootId, s)
    for (const e of s.events) if (e.kind === 'subagent-start' && e.child) announced.add(e.child)
    for (const sa of saved.agents) {
      if (sa.role === 'subagent' && sa.parentId && !parents.has(sa.id)) parents.set(sa.id, { parentId: sa.parentId, provider: sa.provider })
      if (agents.has(sa.id)) continue
      agents.set(sa.id, {
        id: sa.id, role: sa.role, parentId: sa.parentId, provider: sa.provider, route: sa.route,
        task: sa.task, skills: [...(sa.skills ?? [])], stopReason: sa.stopReason, finalOutput: undefined,
        startedAt: sa.startedAt ?? s.startedAt, endedAt: sa.endedAt,
        ...refsFrom(s.events, sa.id),
      })
    }
    log.info(`resumed recording of ${rootId}: ${s.events.length} earlier events`)
  }

  function agent(id) {
    if (!agents.has(id)) restore(rootOf(id))
    let a = agents.get(id)
    if (!a) {
      const p = parents.get(id)
      a = {
        id, role: p ? 'subagent' : 'main', parentId: p?.parentId, provider: p?.provider,
        route: undefined, task: undefined, skills: [], calls: [], steps: [], requestErrors: [],
        stopReason: undefined, finalOutput: undefined, startedAt: Date.now(), endedAt: undefined, callCounter: 0,
      }
      agents.set(id, a)
    }
    return a
  }

  function session(rootId) {
    restore(rootId)
    let s = sessions.get(rootId)
    if (!s) {
      s = { id: rootId, startedAt: Date.now(), updatedAt: Date.now(), events: [], seq: 0, dirty: false }
      sessions.set(rootId, s)
    }
    return s
  }

  /** Append one event to the conversation the agent belongs to. */
  function push(agentId, event) {
    const s = session(rootOf(agentId))
    const e = { seq: ++s.seq, t: Date.now(), agent: agentId, ...event }
    s.events.push(e)
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS)
    s.updatedAt = Date.now()
    s.dirty = true
    return e
  }

  // ---- who is whose parent ------------------------------------------------
  // dsh puts the parent in the child's own session header
  // (header.parentSession, written by the subagent service). subagent/start
  // and subagent/end carry only the child's info, so the parent is read from
  // the live child agent, from any event that carries the agent, or — last
  // resort — from the parent's own tool result "started subagent <id>".
  const parentOfAgent = (ag) => {
    const p = ag?.session?.header?.parentSession
    return typeof p === 'string' && p && p !== ag.id ? p : undefined
  }
  function learn(ag) {
    const p = parentOfAgent(ag)
    if (p) adopt(ag.id, p)
  }
  /** Record childId as a subagent of parentId; move anything already filed elsewhere. */
  function adopt(childId, parentId, provider) {
    if (!childId || !parentId || childId === parentId) return
    const known = parents.get(childId)
    if (known?.parentId === parentId) {
      if (provider && !known.provider) known.provider = provider
      announce(childId)
      return
    }
    const oldRoot = rootOf(childId)
    restore(oldRoot)
    parents.set(childId, { parentId, provider: provider ?? known?.provider })
    const a = agents.get(childId)
    if (a) { a.role = 'subagent'; a.parentId = parentId; if (provider) a.provider = provider }
    const newRoot = rootOf(childId)
    if (oldRoot !== newRoot) mergeSession(oldRoot, newRoot)
    announce(childId)
  }
  /** Put "派出 childId" on the parent's lane once. */
  function announce(childId) {
    if (announced.has(childId)) return
    const p = parents.get(childId)
    if (!p?.parentId) return
    announced.add(childId)
    const a = agents.get(childId)
    push(p.parentId, { kind: 'subagent-start', t: a?.startedAt ?? Date.now(), child: childId, provider: p.provider })
  }
  /** Events recorded under a provisional conversation move into the real one. */
  function mergeSession(fromId, toId) {
    const from = sessions.get(fromId)
    if (!from) return
    sessions.delete(fromId)
    const to = session(toId)
    if (from === to) return
    const all = [...to.events, ...from.events].sort((x, y) => (x.t - y.t) || (x.seq - y.seq))
    all.forEach((e, i) => { e.seq = i + 1 })
    to.events = all
    to.seq = all.length
    to.startedAt = Math.min(to.startedAt, from.startedAt)
    to.dirty = true
    for (const id of new Set(all.map((e) => e.agent))) {
      const a = agents.get(id)
      if (a) Object.assign(a, refsFrom(all, id))
    }
    for (const kind of ['session', 'meta']) unlink(sessionFile(sessionsDir, fromId, kind)).catch(() => {})
    log.info(`moved ${from.events.length} events of ${fromId} into conversation ${toId}`)
  }

  const safe = (label, fn) => {
    try { fn() } catch (error) { log.warn(`${label} failed: ${error?.stack ?? error}`) }
  }

  // ---- messages an agent receives ------------------------------------------
  ctx.on('agent/pre-step', (payload, next) => {
    safe('pre-step', () => {
      const { agent: ag, messages } = payload
      if (ag) learn(ag)
      if (!ag || !messages?.length) return
      const a = agent(ag.id)
      for (const m of messages) {
        const text = textOf(m.content)
        if (!text) continue
        const kind = m.source?.kind
        if (a.role === 'subagent' && a.task === undefined) {
          a.task = text
          push(a.id, { kind: 'task', text: truncate(text, TEXT_KEEP) })
        } else if (kind === 'user') {
          if (a.task === undefined) a.task = text
          push(a.id, { kind: 'user', text: truncate(text, TEXT_KEEP) })
        } else {
          push(a.id, { kind: 'message', from: String(kind ?? 'unknown'), text: truncate(text, 600) })
        }
      }
    })
    return next()
  })

  // ---- which model each agent uses ------------------------------------------
  ctx.on('agent/request', async (payload, next) => {
    const cfg = await next()
    safe('request route', () => {
      if (payload?.agent && cfg?.provider && cfg?.model) agent(payload.agent.id).route = { provider: cfg.provider, model: cfg.model }
    })
    return cfg
  })

  // ---- every model reply ----------------------------------------------------
  ctx.on('agent/assistant-stream', ({ agent: ag, frame }) => {
    safe('stream', () => {
      if (!ag || !frame) return
      if (frame.type === 'start') {
        learn(ag)
        attempts.set(frame.attemptId, {
          agentId: ag.id, t: Date.now(), turn: frame.turn, step: frame.step,
          text: '', reasoningHead: '', reasoningTail: '', reasoningChars: 0, textChars: 0, toolArgChars: 0,
          toolCalls: [], usage: undefined, finish: undefined,
        })
        return
      }
      const st = attempts.get(frame.attemptId)
      if (!st) return
      if (frame.type === 'end') {
        attempts.delete(frame.attemptId)
        const a = agent(st.agentId)
        const e = push(a.id, {
          kind: 'step', t: st.t, end: Date.now(), turn: st.turn, step: st.step,
          text: truncate(st.text, TEXT_KEEP),
          reasoning: st.reasoningChars ? reasoningPreview(st) : undefined,
          reasoningChars: st.reasoningChars, textChars: st.textChars, toolArgChars: st.toolArgChars,
          toolCalls: st.toolCalls, usage: st.usage, finish: st.finish,
        })
        a.steps.push({ seq: e.seq, turn: st.turn, step: st.step, finish: st.finish, usage: st.usage,
          reasoningChars: st.reasoningChars, textChars: st.textChars, toolArgChars: st.toolArgChars })
        return
      }
      const c = frame.chunk
      if (!c) return
      if (c.type === 'reasoning-delta') {
        const t = c.text ?? ''
        st.reasoningChars += t.length
        if (st.reasoningHead.length < REASONING_HEAD) st.reasoningHead += t.slice(0, REASONING_HEAD - st.reasoningHead.length)
        st.reasoningTail = (st.reasoningTail + t).slice(-REASONING_TAIL)
      } else if (c.type === 'text-delta') {
        st.textChars += c.text?.length ?? 0
        if (st.text.length < TEXT_KEEP * 2) st.text += c.text ?? ''
      } else if (c.type === 'tool-call-delta') {
        st.toolArgChars += c.argumentsDelta?.length ?? 0
        if (c.name) st.toolCalls.push(c.name)
      } else if (c.type === 'usage') st.usage = c.usage
      else if (c.type === 'finish') st.finish = c.reason?.kind
    })
  })

  // ---- every tool call -------------------------------------------------------
  ctx.on('tools/pre-execute', (exec, next) => {
    safe('tool start', () => { if (exec?.callId) callStarts.set(exec.callId, Date.now()) })
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    safe('tool end', () => {
      if (!exec?.agent) return
      learn(exec.agent)
      const a = agent(exec.agent.id)
      a.callCounter += 1
      if (exec.name === 'skill' && exec.arguments?.name) a.skills.push(String(exec.arguments.name))
      const started = callStarts.get(exec.callId)
      callStarts.delete(exec.callId)
      const isError = result?.isError === true
      const error = isError ? (result.error?.message ?? textOf(result.content)) : undefined
      const argsPreview = truncate(safeJson(exec.arguments), ARGS_KEEP)
      // fingerprint of the FULL arguments, so repeat detection still works after a restore
      const key = createHash('sha1').update(callKey(exec.name, exec.arguments)).digest('hex').slice(0, 16)
      // fingerprint of the FULL result: a repeat only counts when nothing changed
      const out = createHash('sha1').update(isError ? `E:${error}` : `R:${textOf(result?.content)}`).digest('hex').slice(0, 16)
      const e = push(a.id, {
        kind: 'tool', t: started ?? Date.now(), end: Date.now(), index: a.callCounter,
        name: exec.name, args: argsPreview, key, out, isError,
        error: isError ? truncate(error, RESULT_KEEP) : undefined,
        result: isError ? undefined : truncate(textOf(result?.content), RESULT_KEEP),
      })
      a.calls.push({ seq: e.seq, index: a.callCounter, name: exec.name, key, out,
        argsPreview: truncate(argsPreview, 160), isError, error })
      if (a.calls.length > MAX_EVENTS) a.calls.splice(0, a.calls.length - MAX_EVENTS)
      // fallback parent link: the spawning call reports "started subagent <id>"
      if (!isError) {
        for (const m of textOf(result?.content).matchAll(STARTED_RE)) adopt(m[1], a.id)
      }
    })
    return next()
  })

  // ---- failed model requests ---------------------------------------------
  ctx.on('agent/request-error', (payload, next) => {
    safe('request error', () => {
      const { agent: ag, turn, step, failure } = payload ?? {}
      if (!ag) return
      learn(ag)
      const message = failure?.message ?? safeJson(failure)
      const e = push(ag.id, { kind: 'request-error', turn, step, message: truncate(message, 400) })
      agent(ag.id).requestErrors.push({ seq: e.seq, turn, step, message })
    })
    return next()
  })

  // ---- subagents -------------------------------------------------------------
  // these two events carry only the child's info (no parent argument)
  const liveParent = (childId) => {
    try { return parentOfAgent(ctx.get('agents')?.get(childId)) } catch { return undefined }
  }
  ctx.on('subagent/start', (info) => {
    safe('subagent start', () => {
      const parentId = liveParent(info.id) ?? parents.get(info.id)?.parentId
      if (parentId) adopt(info.id, parentId, info.provider)
      const a = agent(info.id)
      a.role = 'subagent'; a.provider = info.provider; a.stopReason = undefined
      if (parentId) a.parentId = parentId
    })
  })

  ctx.on('subagent/end', (info) => {
    safe('subagent end', () => {
      const parentId = liveParent(info.id) ?? parents.get(info.id)?.parentId
      if (parentId) adopt(info.id, parentId, info.provider)
      const a = agent(info.id)
      a.stopReason = info.stopReason
      a.finalOutput = textOf(info.lastAssistantMessage)
      a.endedAt = Date.now()
      push(a.parentId ?? a.id, {
        kind: 'subagent-end', child: info.id, stopReason: info.stopReason, output: truncate(a.finalOutput, 800),
      })
      flushSoon(rootOf(info.id))
    })
  })

  // ---- main agent turn end ---------------------------------------------------
  ctx.on('agent/turn-stopping', ({ agent: ag, turn }) => {
    safe('turn end', () => {
      if (ag) learn(ag)
      if (!ag || parents.has(ag.id)) return
      const a = agent(ag.id)
      a.stopReason = 'completed'
      a.endedAt = Date.now()
      push(ag.id, { kind: 'turn-end', turn })
      flushSoon(ag.id)
    })
  })

  // ---- writing ---------------------------------------------------------------
  const pending = new Set()
  function flushSoon(rootId) {
    pending.add(rootId)
    setTimeout(() => flushAll(), 500)
  }
  async function flushAll() {
    for (const s of sessions.values()) if (s.dirty) pending.add(s.id)
    const ids = [...pending]
    pending.clear()
    for (const id of ids) {
      const s = sessions.get(id)
      if (!s || !s.events.length) continue
      s.dirty = false
      try {
        const built = buildSession(s, agents, detectOptions)
        await mkdir(sessionsDir, { recursive: true })
        const ai = await readJson(sessionFile(sessionsDir, id, 'ai'))
        await writeFile(sessionFile(sessionsDir, id, 'session'), JSON.stringify(built), 'utf8')
        await writeFile(sessionFile(sessionsDir, id, 'meta'), JSON.stringify(sessionMeta(built, ai)), 'utf8')
      } catch (error) {
        log.warn(`write session ${id} failed: ${error?.message ?? error}`)
      }
    }
  }
  // live view: dirty sessions are written every few seconds while agents work
  ctx.effect(() => {
    const timer = setInterval(() => { flushAll().catch(() => {}) }, FLUSH_MS)
    return () => { clearInterval(timer); flushAll().catch(() => {}) }
  }, 'stuck-monitor: periodic flush')

  // Web panel backend (only under `dsh web`): list, read, AI review.
  ctx.inject(['webServer', 'connection'], (webCtx) => mountRoutes(webCtx, {
    sessionsDir,
    log,
    config,
    routeOf: (sessionId) => agents.get(sessionId)?.route,
  }))
}

// ---- helpers ----------------------------------------------------------------
function reasoningPreview(st) {
  if (st.reasoningChars <= REASONING_HEAD) return st.reasoningHead
  if (st.reasoningChars <= REASONING_HEAD + REASONING_TAIL) return st.reasoningHead + st.reasoningTail.slice(-(st.reasoningChars - st.reasoningHead.length))
  return `${st.reasoningHead} …（省略 ${st.reasoningChars - REASONING_HEAD - REASONING_TAIL} 字）… ${st.reasoningTail}`
}
function textOf(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}
function safeJson(v) {
  try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}
function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== '') out[k] = obj[k]
  return out
}
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}

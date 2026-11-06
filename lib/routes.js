// Host HTTP routes behind the "会话复盘" view. Mounted only under `dsh web`.
//
//   GET  /stuck-monitor/session?id=<any agent/session id>
//        -> { session, ai, focus, aiRunning }   (a subagent id resolves to its conversation)
//   POST /stuck-monitor/analyze?id=<conversation id>[&agent=<agent id>]
//        -> { ai }   one agent's review, or the overall review without `agent` (calls the model)
//
// Every request first passes `connection.requestRejection(req)`: dsh's own
// Host/Origin fence plus login-cookie check (as the official open-in-app
// plugin does), so nothing here is reachable without the dsh token.

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runReview } from './analyze.js'

const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/

export function sessionFile(dir, id, kind) {
  return join(dir, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.${kind}.json`)
}

/** Old review files held a single overall review; the new shape keeps one per agent too. */
export function normalizeAi(ai) {
  if (!ai) return { overall: null, agents: {} }
  if (ai.overall !== undefined || ai.agents !== undefined) return { overall: ai.overall ?? null, agents: ai.agents ?? {} }
  return { overall: ai.report ? ai : null, agents: {} }
}

export function mountRoutes(ctx, { sessionsDir, log, config, routeOf }) {
  const running = new Map()

  const rejected = (req, res) => {
    const connection = ctx.get('connection')
    const rejection = connection ? connection.requestRejection(req) : 403
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
  const method = (req, res, allowed) => {
    if (req.method === allowed) return false
    res.statusCode = 405
    res.setHeader('Allow', allowed)
    res.end()
    return true
  }
  const params = (req) => new URL(String(req.url), 'http://localhost').searchParams

  /** The conversation (root) id an agent or session id belongs to, or null. */
  async function resolveRoot(id) {
    if (await readJsonOrNull(sessionFile(sessionsDir, id, 'meta'))) return id
    let files = []
    try { files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.meta.json')) } catch { return null }
    for (const f of files) {
      const meta = await readJsonOrNull(join(sessionsDir, f))
      if (meta?.agentIds?.includes(id)) return meta.id
    }
    return null
  }

  const route = (path, verb, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (rejected(req, res) || method(req, res, verb)) return
      try {
        await handler(req, res)
      } catch (error) {
        log.warn(`${verb} ${path} failed: ${error?.message ?? error}`)
        sendJson(res, error?.status ?? 500, { error: String(error?.message ?? error) })
      }
    },
  }), `stuck-monitor: ${verb} ${path}`)

  route('/stuck-monitor/session', 'GET', async (req, res) => {
    const id = params(req).get('id') ?? ''
    if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' })
    const root = await resolveRoot(id)
    const session = root && await readJsonOrNull(sessionFile(sessionsDir, root, 'session'))
    if (!session) return sendJson(res, 404, { error: 'not recorded' })
    const ai = normalizeAi(await readJsonOrNull(sessionFile(sessionsDir, root, 'ai')))
    const aiRunning = [...running.keys()].filter((k) => k.startsWith(`${root}|`)).map((k) => k.split('|')[1] || 'overall')
    sendJson(res, 200, { session, ai, focus: id, aiRunning })
  })

  route('/stuck-monitor/analyze', 'POST', async (req, res) => {
    const p = params(req)
    const id = p.get('id') ?? ''
    const agentId = p.get('agent') || ''
    if (!ID_RE.test(id) || (agentId && !ID_RE.test(agentId))) return sendJson(res, 400, { error: 'bad id' })
    const key = `${id}|${agentId}`
    if (!running.has(key)) {
      running.set(key, (async () => {
        const session = await readJsonOrNull(sessionFile(sessionsDir, id, 'session'))
        if (!session) throw Object.assign(new Error('not recorded'), { status: 404 })
        if (agentId && !session.agents.some((a) => a.id === agentId)) throw Object.assign(new Error('no such agent in this conversation'), { status: 404 })
        const main = session.agents.find((a) => a.role === 'main') ?? session.agents[0]
        const aiRoute = config.aiProvider && config.aiModel
          ? { provider: config.aiProvider, model: config.aiModel }
          : routeOf(id) ?? main?.route ?? session.agents.find((a) => a.route)?.route
        const aiPath = sessionFile(sessionsDir, id, 'ai')
        const before = normalizeAi(await readJsonOrNull(aiPath))
        const review = await runReview(ctx.get('llm'), aiRoute, session, {
          scope: agentId ? 'agent' : 'overall',
          agentId: agentId || undefined,
          agentReviews: before.agents,
          maxTokens: config.aiMaxTokens || 6000,
        })
        review.forUpdatedAt = session.updatedAt
        // re-read right before writing: another review may have finished meanwhile
        const latest = normalizeAi(await readJsonOrNull(aiPath))
        if (agentId) latest.agents[agentId] = review
        else latest.overall = review
        await writeFile(aiPath, JSON.stringify(latest), 'utf8')
        return latest
      })().finally(() => running.delete(key)))
    }
    try {
      sendJson(res, 200, { ai: await running.get(key) })
    } catch (error) {
      sendJson(res, error?.status ?? 502, { error: String(error?.message ?? error) })
    }
  })
}

async function readJsonOrNull(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}

function sendJson(res, status, payload) {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

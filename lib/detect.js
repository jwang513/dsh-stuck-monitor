// Pure detection logic: one agent's calls/steps in, findings out.
// Every finding carries `refs` — the exact call indices / step keys it is about —
// so the timeline can put a marker on the right spot.
//
// Each finding has a `level`:
//   error    — it really failed or got stuck (red)
//   external — something outside the agent stopped it: denied, network, cancelled (amber)
//   note     — just a way of working, not a problem: exploring, long thinking (grey band)
// Repeats and cycles only count when the RESULTS repeat too: the same call
// returning something new each time (polling, edit→test) is progress.

export const DEFAULTS = {
  repeatThreshold: 3,        // same call N times in a row
  cycleMinRepeats: 2,        // a pattern (A,B) must repeat this many extra times: A,B,A,B,A,B
  cycleMaxLen: 4,            // longest pattern checked (A,B,C,D)
  repeatedErrorThreshold: 3, // same error N times (anywhere)
  readOnlyStretch: 15,       // N read-type calls in a row with no write-type call
  reasoningWarnTokens: 8000, // one model reply's reasoning above this
  readToolPattern: '(^|_)(read|view|grep|glob|search|find|list|ls|cat|fetch|web)',
  writeToolPattern: '(write|edit|replace|create|patch|apply|delete|remove|move|rename|mkdir)',
  denialPattern: 'approval|rejected|denied|not permitted|permission|sandbox|EACCES|EPERM',
  // bookkeeping tools: ignored by repeat/cycle/read-only checks (neither count nor break a streak)
  transparentToolPattern: '^(todo_write)$',
}

export const TYPE_LABEL = {
  'exact-repeat': '原地重复',
  'cycle': '来回打转',
  'repeated-error': '同一错误反复出现',
  'permission-denied': '操作被拒绝',
  'explore': '探查',
  'max-tokens': '输出撞上限',
  'reasoning-heavy': '长思考',
  'abnormal-end': '没有正常结束',
  'aborted': '被取消',
  'request-error': '模型请求失败',
}

export const LEVEL_LABEL = { error: '问题', external: '外部阻拦', note: '记录' }
const SEVERITY = { error: 'high', external: 'medium', note: 'low' }

/** Stable key for "the same call": tool name + arguments with sorted object keys. */
export function callKey(name, args) {
  return JSON.stringify([name, canonical(args)])
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k])
    return out
  }
  return value
}

/** Error text normalised so "line 12" and "line 13" count as the same error. */
export function errorKey(name, message) {
  const m = String(message ?? '')
    .replace(/[A-Za-z]:\\[^\s'"]+|\/[^\s'"]+/g, '<path>')
    .replace(/\d+/g, 'N')
    .slice(0, 200)
  return `${name}: ${m}`
}

/**
 * @param trace {{ calls, steps, requestErrors, stopReason?, finalOutput? }}
 *   calls: [{ index, name, key, out, argsPreview, isError, error }]   (out = fingerprint of the result)
 *   steps: [{ turn, step, finish, usage, reasoningChars, textChars }]
 * @returns [{ type, label, level, severity, title, evidence: string[], refs: { calls: number[], steps: string[] } }]
 */
export function detect(trace, options = {}) {
  const o = { ...DEFAULTS, ...options }
  const findings = []
  const allCalls = trace.calls ?? []
  const transparent = new RegExp(o.transparentToolPattern, 'i')
  const calls = allCalls.filter((c) => !transparent.test(c.name))
  const steps = trace.steps ?? []
  const stepKey = (s) => `${s.turn}.${s.step}`
  const add = (type, level, title, evidence, refs = {}) => findings.push({
    type, label: TYPE_LABEL[type] ?? type, level, severity: SEVERITY[level], title, evidence,
    refs: { calls: refs.calls ?? [], steps: refs.steps ?? [] },
  })
  const range = (from, len) => calls.slice(from, from + len).map((c) => c.index)

  // same call AND same result: nothing changed between the attempts
  const sameKey = (c) => `${c.key}#${c.out ?? ''}`

  // 1. exact repeats: longest run of the same call with the same result
  {
    let best = null
    let runStart = 0
    for (let i = 1; i <= calls.length; i++) {
      if (i < calls.length && sameKey(calls[i]) === sameKey(calls[runStart])) continue
      const len = i - runStart
      if (len >= o.repeatThreshold && (!best || len > best.len)) best = { start: runStart, len }
      runStart = i
    }
    if (best) {
      const c = calls[best.start]
      add('exact-repeat', 'error', `同一个调用连续执行了 ${best.len} 次，参数和返回结果都完全一样`,
        [`${c.name} ${c.argsPreview}`], { calls: range(best.start, best.len) })
    }
  }

  // 2. cycles: a 2..cycleMaxLen pattern repeated back to back, results unchanged
  {
    const keys = calls.map(sameKey)
    let best = null
    for (let len = 2; len <= o.cycleMaxLen; len++) {
      for (let start = 0; start + len * (o.cycleMinRepeats + 1) <= keys.length; start++) {
        const pattern = keys.slice(start, start + len)
        if (new Set(pattern).size < 2) continue
        let reps = 1
        while (start + (reps + 1) * len <= keys.length &&
          pattern.every((k, j) => keys[start + reps * len + j] === k)) reps++
        if (reps >= o.cycleMinRepeats + 1 && (!best || reps * len > best.reps * best.len)) best = { start, len, reps }
      }
    }
    if (best) {
      const seq = calls.slice(best.start, best.start + best.len).map((c, i) => `${String.fromCharCode(65 + i)}. ${c.name} ${c.argsPreview}`)
      add('cycle', 'error', `${best.len} 个调用组成的循环来回重复了 ${best.reps} 轮，每轮结果都一样`, seq,
        { calls: range(best.start, best.len * best.reps) })
    }
  }

  // 3. repeated errors and 4. denials
  {
    const denial = new RegExp(o.denialPattern, 'i')
    const byKey = new Map()
    const denials = []
    for (const c of allCalls) {
      if (!c.isError) continue
      if (denial.test(c.error ?? '')) denials.push(c)
      const k = errorKey(c.name, c.error)
      const list = byKey.get(k) ?? []
      list.push(c)
      byKey.set(k, list)
    }
    for (const list of byKey.values()) {
      if (list.length < o.repeatedErrorThreshold) continue
      add('repeated-error', 'error', `${list[0].name} 报了 ${list.length} 次同一类错误`,
        [truncate(list[0].error, 300)], { calls: list.map((c) => c.index) })
    }
    if (denials.length) {
      add('permission-denied', 'external', `操作被拒绝 ${denials.length} 次`,
        denials.slice(0, 5).map((c) => `${c.name} ${c.argsPreview} → ${truncate(c.error, 200)}`),
        { calls: denials.map((c) => c.index) })
    }
  }

  // 5. exploring: long read-only stretches (a note, not a problem)
  {
    const read = new RegExp(o.readToolPattern, 'i')
    const write = new RegExp(o.writeToolPattern, 'i')
    let start = -1
    for (let i = 0; i <= calls.length; i++) {
      const c = calls[i]
      const isRead = c && read.test(c.name) && !write.test(c.name)
      if (isRead) { if (start < 0) start = i; continue }
      if (start >= 0) {
        const len = i - start
        if (len >= o.readOnlyStretch) {
          const names = {}
          for (const x of calls.slice(start, i)) names[x.name] = (names[x.name] ?? 0) + 1
          add('explore', 'note', `连续 ${len} 次只读调用`,
            [Object.entries(names).map(([n, k]) => `${n}×${k}`).join('，')], { calls: range(start, len) })
        }
        start = -1
      }
    }
  }

  // 6. max-tokens, 7. heavy reasoning
  {
    const capped = steps.filter((s) => s.finish === 'max-tokens')
    if (capped.length) {
      add('max-tokens', 'error', `回复写到一半撞上了输出上限，被截断 ${capped.length} 次`,
        capped.map((s) => describeStep(s)), { steps: capped.map(stepKey) })
    } else if (trace.stopReason === 'max-tokens') {
      add('max-tokens', 'error', '因为撞上 token 上限而结束', [])
    }
    const heavy = steps.filter((s) => s.finish !== 'max-tokens' && (s.usage?.reasoningTokens ?? 0) >= o.reasoningWarnTokens)
    if (heavy.length) {
      add('reasoning-heavy', 'note', `${heavy.length} 次回复的思考超过 ${o.reasoningWarnTokens} tokens`,
        heavy.slice(0, 5).map((s) => describeStep(s)), { steps: heavy.map(stepKey) })
    }
  }

  // 8. abnormal end, 9. request errors
  if (trace.stopReason === 'aborted') {
    add('aborted', 'external', '被取消（可能是手动停止，也可能是上级 agent 取消了它）',
      trace.finalOutput ? [truncate(trace.finalOutput, 300)] : [])
  } else if (trace.stopReason && !['completed', 'max-tokens'].includes(trace.stopReason)) {
    add('abnormal-end', 'error', `没有正常结束（${trace.stopReason === 'refusal' ? '拒绝执行' : trace.stopReason === 'error' ? '出错' : trace.stopReason}）`,
      trace.finalOutput ? [truncate(trace.finalOutput, 300)] : [])
  }
  if ((trace.requestErrors ?? []).length) {
    add('request-error', 'external', `模型请求失败 ${trace.requestErrors.length} 次`,
      trace.requestErrors.slice(0, 5).map((e) => truncate(e.message, 200)),
      { steps: trace.requestErrors.map((e) => `${e.turn}.${e.step}`) })
  }

  const order = { error: 0, external: 1, note: 2 }
  return findings.sort((a, b) => order[a.level] - order[b.level])
}

export function describeStep(s) {
  const total = (s.reasoningChars ?? 0) + (s.textChars ?? 0) + (s.toolArgChars ?? 0)
  const pct = (n) => (total ? Math.round(((n ?? 0) / total) * 100) : 0)
  let out = `思考 ${pct(s.reasoningChars)}%，正文 ${pct(s.textChars)}%，工具参数 ${pct(s.toolArgChars)}%`
  if (s.usage) {
    out += `；输出 ${s.usage.outputTokens ?? '?'} tokens` +
      (s.usage.reasoningTokens != null ? `（推理 ${s.usage.reasoningTokens}）` : '')
  }
  return out
}

export function truncate(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

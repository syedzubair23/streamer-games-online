export const meta = {
  name: 'sgo-v1',
  description: 'Build Streamer Games Online v1: DAG-scheduled roadmap items in isolated worktrees, fresh verifier+critic loops, serialized merges, wave triage',
  whenToUse: 'Full v1 build/resume of docs/ROADMAP.md',
  phases: [
    { title: 'Sync', detail: 'Step 0: verify + progress lifecycle for already-built M0 items' },
    { title: 'Build', detail: 'builders in per-item git worktrees' },
    { title: 'Verify', detail: 'fresh functional verifiers (DoD gates)' },
    { title: 'Critic', detail: 'fresh harsh visual critics (rubric)' },
    { title: 'Fix', detail: 'builder fixes critic/verifier issues' },
    { title: 'Content QA', detail: 'trivia fact-check + 10% re-check' },
    { title: 'Merge', detail: 'serialized merge to main, re-verify, progress lifecycle' },
    { title: 'Triage', detail: 'engine-requests triage + drift pixel-diff between waves' },
  ],
}

// ---------- config ----------
const ROOT = 'E:/Game/streamer-games-online'
const WT = 'E:/Game/sgo-wt'
const CAP = (args && args.cap) || 7
const MAX_ROUNDS = 5
const skip = new Set((args && args.skipDone) || [])   // ids already done on main (for resume)

// ---------- item graph ----------
const I = []
const add = (id, o) => I.push(Object.assign({ id, deps: [], after: [], visual: false, kind: 'item', prio: 5, note: '' }, o))

add('SYNC', { kind: 'sync', prio: -9 })
add('M0-04', { deps: ['SYNC'], prio: -8, note: 'Full focus: everything else waits on this. The engine may be partially started on main (packages/engine/src/game-module.ts); inspect and complete it.' })
add('M0-05', { deps: ['M0-04'], prio: -8, note: 'Full focus: everything else waits on this.' })
const S2 = ['M0-05']
// M1 server track
add('M1-01', { deps: S2, prio: 0 })
add('M1-02', { deps: ['M1-01'], prio: 0 })
add('M1-03', { deps: ['M1-02'], prio: 0 })
add('M1-04', { deps: ['M1-02'], prio: 1 })
add('M1-10', { deps: ['M1-03'], prio: 3 })
// M1 visual track
add('M1-05', { deps: S2, prio: 0, visual: true })
add('M1-06', { deps: S2, prio: 0 })  // DOD P6: no visual critic
add('M1-07', { deps: ['M1-06'], prio: 0, visual: true })
add('M1-08', { deps: S2, prio: 1 })  // DOD P6: no visual critic
add('M1-09', { deps: ['M1-02', 'M1-03', 'M1-04', 'M1-05', 'M1-07', 'M1-08'], prio: 0, visual: true })

const GAMES = [
  { m: 'M2', id: 'quip-clash', wave: 'G' },
  { m: 'M3', id: 'tune-in', wave: 'A' },
  { m: 'M4', id: 'trivia-night', wave: 'A' },
  { m: 'M5', id: 'doodle', wave: 'A' },
  { m: 'M6', id: 'odd-one-out', wave: 'B' },
  { m: 'M7', id: 'ludo', wave: 'B' },
  { m: 'M8', id: 'chess', wave: 'B' },
  { m: 'M9', id: 'marble-rally', wave: 'C' },
]
const WAVE_GATE = { G: [], A: ['M2-06'], B: ['M2-06', 'TRIAGE-A'], C: ['M2-06', 'TRIAGE-B'] }
const waveItems = { A: [], B: [], C: [] }

add('M9-00', { deps: S2, prio: 2, note: 'Physics solver (ROADMAP M9 section).' })
add('M9-00b', { deps: ['M9-00'], prio: 2, note: 'Tracks + preview renderer (ROADMAP M9 section).' })

for (const g of GAMES) {
  const m = g.m, gate = WAVE_GATE[g.wave], golden = g.wave === 'G'
  const gnote = `Game "${g.id}": follow docs/specs/${g.id}.md exactly.`
  add(`${m}-01`, { deps: m === 'M9' ? [...S2, 'M9-00', 'M9-00b'] : S2, prio: 2, note: gnote })
  add(`${m}-02`, { deps: S2, prio: 3, kind: m === 'M4' ? 'trivia-content' : 'item', note: gnote })
  const stageDeps = [`${m}-01`, 'M1-07', 'M1-09', ...gate]
  if (m === 'M5') {
    add('M5-06', { deps: ['M5-01', 'M1-06', 'M1-09', ...gate], prio: 1, note: gnote + ' Stroke pipeline (ROADMAP M5-06).' })
    stageDeps.push('M5-06')
  }
  add(`${m}-03`, { deps: stageDeps, prio: golden ? -5 : 1, visual: true, note: gnote + (golden ? ' THIS IS THE STYLE GOLDEN: strongest effort, the bar every later game is judged against.' : ' Must match docs/references/_style/golden.') })
  add(`${m}-04`, { deps: [`${m}-01`, 'M1-05', 'M1-09', ...gate], prio: golden ? -5 : 1, visual: true, note: gnote })
  add(`${m}-05`, { deps: [`${m}-01`, `${m}-02`, `${m}-03`, `${m}-04`], prio: golden ? -5 : 1, visual: true, note: gnote + ' Run all G-gates (pnpm verify:game) and the full critic loop.' })
  if (!golden) waveItems[g.wave].push(`${m}-01`, `${m}-02`, `${m}-03`, `${m}-04`, `${m}-05`, ...(m === 'M5' ? ['M5-06'] : []), ...(m === 'M9' ? ['M9-00', 'M9-00b'] : []))
}
add('M2-06', { deps: ['M2-05'], prio: -5, visual: true, kind: 'golden', note: 'Golden promotion per ROADMAP M2-06; re-run critic on M1 platform scenarios against the golden.' })
// cut-first items: never gate anything
add('M4-01b', { deps: ['M4-01'], prio: 9, note: 'Cut-first (Bluff mode logic). Game "trivia-night", docs/specs/trivia-night.md.' })
add('M5-01b', { deps: ['M5-01'], prio: 9, note: 'Cut-first (Telephone mode logic). Game "doodle", docs/specs/doodle.md.' })
add('M8-01b', { deps: ['M8-01'], prio: 9, note: 'Cut-first (Team vs Team + guess-the-move). Game "chess", docs/specs/chess.md.' })

add('TRIAGE-A', { kind: 'triage', after: waveItems.A, deps: [], prio: -7, note: 'A' })
add('TRIAGE-B', { kind: 'triage', after: waveItems.B, deps: [], prio: -7, note: 'B' })

const allGameFinals = GAMES.map(g => `${g.m}-05`)
add('M10-01', { deps: ['M1-09', 'TRIAGE-B'], prio: 4, visual: true })
add('M10-02', { deps: ['M1-03', 'TRIAGE-B'], prio: 4 })
add('M10-03', { deps: ['M1-02', 'TRIAGE-B'], prio: 4 })
add('M10-04', { deps: ['M1-09', 'TRIAGE-B'], prio: 4 })
add('M10-05', { deps: ['M1-09', 'TRIAGE-B'], prio: 4 })
add('M10-06', { deps: ['M7-05', 'M8-05', 'TRIAGE-B'], prio: 4, visual: true })
add('M10-08', { deps: ['TRIAGE-B'], after: allGameFinals, prio: 4, visual: true })
add('M10-11', { deps: ['TRIAGE-B'], after: [...allGameFinals, 'M10-01', 'M10-02', 'M10-03', 'M10-04', 'M10-05', 'M10-06', 'M10-08'], prio: 6 })
add('M10-07', { deps: ['TRIAGE-B'], after: [...allGameFinals, 'M10-01', 'M10-02', 'M10-03', 'M10-04', 'M10-05', 'M10-06', 'M10-08', 'M10-11', 'M4-01b', 'M5-01b', 'M8-01b', 'M1-10'], prio: 7 })
add('M10-09', { deps: [], after: ['M10-07'], prio: 7, visual: true })
add('M10-10', { deps: [], after: ['M10-09'], prio: 7 })

const byId = Object.fromEntries(I.map((it, i) => [it.id, Object.assign(it, { port: 5200 + i * 4 })]))

// ---------- prompts ----------
const HOUSE = `Repo: ${ROOT} (public GitHub repo; Windows; use Bash with POSIX syntax; pnpm; Node 22). CLAUDE.md, docs/SPEC.md, docs/ROADMAP.md, docs/DOD.md and docs/specs/*.md are authoritative and win over this prompt. Never skip, weaken, fake or stub a test, lint rule, DoD gate, scenario, critic round or rubric threshold. Public repo: never put secrets, absolute local machine paths, or third-party images in tracked files; do not bypass .githooks/pre-commit; never push.
RESOURCE LIMITS (the dev laptop overheats; other agents run in parallel): run vitest with --maxWorkers=2 (or --pool=forks --poolOptions.forks.maxForks=2), Playwright with --workers=1, never run the full repo test suite more than needed (prefer the item's own package, then one final full run), never use watch mode, and ALWAYS kill any dev server / vite preview / browser you started before finishing (track PIDs; do not leave background processes).`

const wtPath = it => `${WT}/${it.id}`
const WT_RULES = it => `ISOLATION: work ONLY in the git worktree ${wtPath(it)} on branch item/${it.id}. If it does not exist, create it from current main: \`git -C ${ROOT} worktree add ${wtPath(it)} -b item/${it.id} main\` then \`cd ${wtPath(it)} && pnpm install\`. If it exists, cd into it (and if main has moved on, \`git merge main\` into the branch first). Never edit files in ${ROOT} itself. Commit your work on item/${it.id} with messages "${it.id}: <what>". Do not edit progress.json or PROGRESS.md (the merger does that). Ownership (ROADMAP "Ownership rules"): only edit the files your item owns; game items that need engine changes append a request to docs/engine-requests.md instead. Use ports ${it.port}-${it.port + 3} for any dev server / Playwright webServer to avoid clashing with parallel agents (set via env/CLI flags, do not change committed defaults).`

const spec = it => `ROADMAP item ${it.id}. ${it.note} Read its full definition (Goal/Files/Depends/Accept) in docs/ROADMAP.md, the applicable DoD gates in docs/DOD.md (Platform P-gates or Game G-gates), and the relevant SPEC sections.`

const VERDICT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    score: { type: 'number' },
    issues: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, what: { type: 'string' }, where: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'what', 'fix'] } },
    evidence: { type: 'string' },
  },
  required: ['pass', 'score', 'issues', 'evidence'],
}
const FIXRES = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    disputed: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, reason: { type: 'string' } }, required: ['issue', 'reason'] } },
  },
  required: ['summary', 'disputed'],
}
const MERGERES = { type: 'object', properties: { merged: { type: 'boolean' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['merged', 'status', 'notes'] }
const TRIAGERES = {
  type: 'object',
  properties: {
    implemented: { type: 'array', items: { type: 'string' } },
    deferred: { type: 'array', items: { type: 'string' } },
    openRequests: { type: 'number' },
    regressedFinals: { type: 'array', items: { type: 'string' }, description: 'Mx-05 ids of done games whose screenshots changed >2% and must go back to the critic' },
    notes: { type: 'string' },
  },
  required: ['implemented', 'deferred', 'openRequests', 'regressedFinals', 'notes'],
}

// ---------- merge mutex (serialize all writes to main) ----------
let mainLock = Promise.resolve()
const onMain = fn => { const p = mainLock.then(fn, fn); mainLock = p.catch(() => {}); return p }

const disputes = []
const state = {}          // id -> pending|running|done|blocked|error|skipped
const reasons = {}

function mergeItem(it, rounds, criticRounds) {
  return onMain(() => agent(`${HOUSE}\n\nYou are the MERGER (the only agent allowed to write to main in ${ROOT}). Item ${it.id} passed independent verification${it.visual ? ' and the visual critic' : ''} in worktree ${wtPath(it)} (branch item/${it.id}; ${rounds} round(s), ${criticRounds} critic round(s)).
1. In ${ROOT} (main, must be clean): \`git merge --no-ff item/${it.id}\`. Resolve conflicts carefully: shared root files (package.json, pnpm-lock.yaml, tsconfig refs, docs/engine-requests.md) take the UNION of both sides; re-run \`pnpm install\` after lockfile/package changes. Never drop another item's work.
2. Copy artifacts/handoff/${it.id}.md from the worktree to ${ROOT}/artifacts/handoff/ (artifacts are untracked). Re-run the item's verification on main at the new commit (\`pnpm verify:item ${it.id}\` or \`pnpm verify:game <game>\` as DOD/CLAUDE.md specify; if that tool does not exist yet for this item, run the Accept commands) so artifacts/verify/${it.id}.json is green at the CURRENT commit. Also run \`pnpm typecheck && pnpm lint && pnpm test\` on main — main must stay green; if the merge broke anything, fix it minimally on main (commit "${it.id}: merge fix") or \`git merge --abort\`/revert and report merged=false.
3. Move the item through the legal lifecycle ONLY with \`pnpm progress set\` (never hand-edit progress.json): todo→building→verifying→(critic, recording criticRound=${criticRounds} if the CLI tracks it)→done, as docs/DOD.md §8 requires. Then \`pnpm progress render\` and commit progress.json + PROGRESS.md as "${it.id}: done".
4. Remove the worktree (\`git worktree remove ${wtPath(it)} --force\`) and delete branch item/${it.id} only after a successful merge.
Before every commit, review \`git diff --cached\` for secrets, absolute local paths, third-party images.`, { label: `merge:${it.id}`, phase: 'Merge', schema: MERGERES }))
}

function recordBlocked(it, reason) {
  return onMain(() => agent(`${HOUSE}\n\nIn ${ROOT} (main): mark roadmap item ${it.id} as blocked using ONLY \`pnpm progress set ${it.id} status=blocked blockedReason="..."\` (see \`pnpm progress --help\`), with this reason: ${JSON.stringify(reason.slice(0, 400))}. Then \`pnpm progress render\` and commit progress.json + PROGRESS.md as "${it.id}: blocked". Leave the worktree ${wtPath(it)} and branch item/${it.id} in place for later. Reply with one line.`, { label: `block:${it.id}`, phase: 'Merge', effort: 'low' }))
}

async function reviewLoop(it, label) {
  let criticRounds = 0
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const verifyP = agent(`${HOUSE}\n\n${WT_RULES(it)}\n\nYou are a FRESH, INDEPENDENT, HARSH FUNCTIONAL VERIFIER for ${spec(it)}\nYou did not build it; trust nothing the builder claims. In the worktree, re-run every Accept check and every applicable DoD gate yourself (typecheck, lint, tests, the item's verify command / pnpm verify:game for game items, perf/bundle budgets, scenario registration). Read the code for faked/stubbed/hard-coded behaviour, tests that assert nothing, skipped tests, weakened lint/rules, missing files from the "Files" list, deviations from SPEC. Default pass=false if anything required is missing or unverified. Do not modify source code (you may write artifacts). Give concrete, actionable issues.`,
      { label: `verify:${it.id}#${round}`, phase: 'Verify', schema: VERDICT })
    const criticP = it.visual ? agent(`${HOUSE}\n\n${WT_RULES(it)}\n\nYou are a FRESH, BRUTALLY HARSH VISUAL + UX CRITIC (AAA cozy-game art director) for ${spec(it)}\nFollow docs/critic/CRITIC_PROMPT.md and docs/critic/RUBRIC.md exactly (thresholds, ★ items, blind A/B where specified, stream-sim 720p review, all 5 ambient modes, desktop + phone viewports, reduced motion). Capture evidence with the harness in the worktree (scenario route + pnpm screenshot/contact-sheet/clips tooling from M0-05; if an item predates some tooling, write a small Playwright script using the installed chromium). LOOK at every image with the Read tool. Compare against docs/references/_style (and _style/golden once it exists). Judge motion from clips/frame sequences, not assumptions. Any rubric item under its threshold = fail. Write your report to artifacts/critic/${it.id}/round-${round}.json in the worktree conforming to docs/critic/report.schema.json and commit it on branch item/${it.id} ("${it.id}: critic round ${round}"). Do not modify source code. Default to fail when in doubt.`,
      { label: `critic:${it.id}#${round}`, phase: 'Critic', schema: VERDICT }) : Promise.resolve({ pass: true, score: 10, issues: [], evidence: 'no visuals' })
    const [v, c] = await Promise.all([verifyP, criticP])
    if (it.visual) criticRounds++
    if (!v || !c) return { status: 'error', reason: `agent failure in round ${round}` }
    log(`${it.id} r${round}: verify=${v.pass}(${v.score}) critic=${c.pass}(${c.score})`)
    if (v.pass && c.pass) return { status: 'pass', rounds: round, criticRounds }
    if (round === MAX_ROUNDS) {
      const top = [...v.issues, ...c.issues].filter(x => x.severity !== 'minor').slice(0, 5).map(x => x.what).join(' | ')
      return { status: 'blocked', reason: `failed ${MAX_ROUNDS} rounds (verify ${v.score}, critic ${c.score}): ${top}` }
    }
    const f = await agent(`${HOUSE}\n\n${WT_RULES(it)}\n\nYou are the BUILDER fixing ${spec(it)}\nRound ${round} was rejected by fresh independent reviewers. Fix every issue at the root cause (no hacks, no weakening checks), re-run the checks, update artifacts/verify/${it.id}.json and artifacts/handoff/${it.id}.md, commit on item/${it.id}. If you are CERTAIN an issue contradicts SPEC/DOD/the game spec, you may dispute it instead of fixing: list it in "disputed" with the exact doc reference (disputes are reported to the human; the next reviewer decides).\nFunctional verifier (pass=${v.pass}, score ${v.score}):\n${JSON.stringify(v.issues)}\nEvidence: ${v.evidence.slice(0, 3000)}\n${it.visual ? `Visual critic (pass=${c.pass}, score ${c.score}):\n${JSON.stringify(c.issues)}\nEvidence: ${c.evidence.slice(0, 3000)}` : ''}`,
      { label: `fix:${it.id}#${round}`, phase: 'Fix', schema: FIXRES })
    if (!f) return { status: 'error', reason: `fixer failure round ${round}` }
    for (const d of f.disputed) disputes.push({ id: it.id, round, ...d })
  }
}

async function build(it) {
  const r = await agent(`${HOUSE}\n\n${WT_RULES(it)}\n\nYou are the BUILDER for ${spec(it)}\nThe item may already be partially built (check the branch/worktree and main); continue from what exists. Build it completely to production / AAA-polish quality — no TODO stubs for anything in scope. Write tests for every Accept criterion and run them plus \`pnpm typecheck && pnpm lint && pnpm test\` in the worktree. Write artifacts/handoff/${it.id}.md (what was built, how to verify, known limits) and artifacts/verify/${it.id}.json (every Accept criterion + DoD gate → command → result). Commit on item/${it.id}. Final reply: what you built, what passes, anything you could not do.`,
    { label: `build:${it.id}`, phase: 'Build' })
  return r
}

async function triviaQA(it) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const fc = await agent(`${HOUSE}\n\n${WT_RULES(it)}\n\nYou are an INDEPENDENT FACT-CHECKER (you did not write these items) for ROADMAP M4-02 trivia content. Check EVERY item (not a sample) in the trivia packs in the worktree against reliable sources (use WebSearch/WebFetch via ToolSearch). Record {id, verdict: ok|wrong|unverifiable, checkedAgainst} for each in artifacts/content/trivia-factcheck.json. Fix wrong items with a correct answer + source, or drop them (keep counts meeting the ROADMAP minimums by writing replacements you then also check). Enforce the validUntil rule for records/current holders/prices/populations. Commit on item/M4-02. Split the work across as many sequential passes as needed; do not stop until every item has a verdict. Reply with counts.`,
      { label: `factcheck:M4-02#${attempt}`, phase: 'Content QA' })
    if (!fc) return false
    const re = await agent(`${HOUSE}\n\n${WT_RULES(it)}\n\nYou are a THIRD, INDEPENDENT trivia re-checker (you wrote none of the items and did none of the first fact-check). Deterministically sample 10% of all trivia items in the worktree packs (every 10th item by sorted id) and verify each against reliable sources yourself. Zero errors are allowed. Write artifacts/content/trivia-recheck.json. Reply pass=true only if 0 errors.`,
      { label: `recheck:M4-02#${attempt}`, phase: 'Content QA', schema: VERDICT })
    if (!re) return false
    log(`M4-02 fact-check attempt ${attempt}: recheck pass=${re.pass}`)
    if (re.pass) return true
  }
  return false
}

async function triage(it) {
  const wave = it.note
  const res = await onMain(() => agent(`${HOUSE}\n\nYou are the ENGINE OWNER doing between-wave triage after Wave ${wave}, working directly on main in ${ROOT} (all merges are paused while you work).
1. BEFORE any engine change: capture the full screenshot set (pnpm verify:game / screenshots harness, swiftshader project) for every game whose Mx-05 is done per progress.json, into artifacts/drift/before/<game>/.
2. Triage docs/engine-requests.md: implement accepted requests in packages/{shared,engine,render,ui,audio}, apps/*, tools/* with tests (owner-only files), mark each request accepted/deferred/rejected with a reason in the file. Keep main green (pnpm typecheck && pnpm lint && pnpm test). Commit as "TRIAGE-${wave}: <what>".
3. If any engine change was made: re-capture into artifacts/drift/after/<game>/ and pixelmatch each pair. Any game with >2% pixels changed on any shot goes back to the critic: list its Mx-05 id in regressedFinals (and set it back with \`pnpm progress set <id> status=fixing\` or the legal equivalent).
4. Write artifacts/reports/wave-${wave}.md: items done, blocked (reasons from progress.json), open engine requests, drift results.`, { label: `triage:${wave}`, phase: 'Triage', schema: TRIAGERES }))
  return res
}

function summarize(label, ids) {
  const g = s => ids.filter(id => state[id] === s)
  const blocked = g('blocked').map(id => `${id} (${reasons[id] || ''})`)
  log(`=== ${label} === done: ${g('done').join(', ') || '-'} | blocked: ${blocked.join('; ') || '-'} | skipped (dep blocked): ${g('skipped').join(', ') || '-'} | errors: ${g('error').join(', ') || '-'} | disputes so far: ${disputes.length}`)
}

async function runItem(it) {
  if (it.kind === 'sync') {
    const r = await agent(`${HOUSE}\n\nSTEP 0 (sync state), on main in ${ROOT}. git log shows M0-01, M0-02, M0-03 and M0-06 were built, but progress.json still says todo. Note: \`pnpm lint\` currently fails on .claude/workflows/*.js (orchestration scripts, not product code) — add .claude/ to the eslint ignores (and prettier ignore) as a minimal config change. Also ensure /artifacts/handoff/ exists as needed. For each of M0-01, M0-02, M0-03, M0-06: write/refresh artifacts/handoff/<id>.md, run its verification and Accept checks at the current commit to produce a green artifacts/verify/<id>.json (M0-06: its calibration run; it has a critic artifact under artifacts/critic/ if the progress CLI requires one — follow DOD §8), then move it through the legal lifecycle with \`pnpm progress set\` only (never hand-edit progress.json). If any of them FAILS verification, fix it properly first. Render PROGRESS.md, commit ("M0: sync progress"). Also commit the .claude/workflows scripts if untracked (they contain no secrets). Reply ok=true only if all four are done.`,
      { label: 'sync:M0', phase: 'Sync', schema: { type: 'object', properties: { ok: { type: 'boolean' }, notes: { type: 'string' } }, required: ['ok', 'notes'] } })
    if (!r) return { status: 'error', reason: 'sync agent failed' }
    return r.ok ? { status: 'done' } : { status: 'blocked', reason: r.notes }
  }
  if (it.kind === 'triage') {
    const r = await triage(it)
    if (!r) return { status: 'error', reason: 'triage agent failed' }
    log(`Triage ${it.note}: implemented ${r.implemented.length}, deferred ${r.deferred.length}, open requests ${r.openRequests}, regressed: ${r.regressedFinals.join(', ') || 'none'}`)
    // send regressed games back through a fresh critic loop, then re-merge
    await parallel(r.regressedFinals.filter(id => byId[id]).map(id => async () => {
      const rit = Object.assign({}, byId[id], { id: `${id}`, note: byId[id].note + ` RE-CRITIC after TRIAGE-${it.note} engine change (drift >2%). Fix any regressions.` })
      const rr = await reviewLoop(rit)
      if (rr.status === 'pass') await mergeItem(rit, rr.rounds, rr.criticRounds)
      else { state[id] = rr.status === 'blocked' ? 'blocked' : 'error'; reasons[id] = rr.reason; if (rr.status === 'blocked') await recordBlocked(rit, rr.reason) }
    }))
    summarize(`WAVE ${it.note} REPORT`, [...waveItems[it.note], ...(it.note === 'A' ? ['M4-01b', 'M5-01b'] : ['M8-01b'])])
    if (disputes.length) log(`Disputed critic issues: ${JSON.stringify(disputes.slice(-15))}`)
    return { status: 'done' }
  }
  const b = await build(it)
  if (!b) return { status: 'error', reason: 'builder failed' }
  if (it.kind === 'trivia-content') {
    const ok = await triviaQA(it)
    if (!ok) return { status: 'blocked', reason: 'trivia fact-check / 10% re-check did not reach 0 errors in 3 attempts' }
  }
  const rv = await reviewLoop(it)
  if (rv.status !== 'pass') return rv
  const m = await mergeItem(it, rv.rounds, rv.criticRounds)
  if (!m) return { status: 'error', reason: 'merger failed' }
  if (!m.merged) return { status: 'blocked', reason: `merge failed: ${m.notes}` }
  return { status: 'done' }
}

// ---------- DAG scheduler ----------
for (const it of I) state[it.id] = skip.has(it.id) ? 'done' : 'pending'
const settled = s => s === 'done' || s === 'blocked' || s === 'skipped'
let running = 0
let halted = false   // set when any agent errors (e.g. usage limit): stop launching, drain, return for resume
const REPORT_POINTS = { 'M2-06': ['M0-04', 'M0-05', 'M1-01', 'M1-02', 'M1-03', 'M1-04', 'M1-05', 'M1-06', 'M1-07', 'M1-08', 'M1-09', 'M1-10', 'M2-01', 'M2-02', 'M2-03', 'M2-04', 'M2-05', 'M2-06', ...GAMES.slice(1).flatMap(g => [`${g.m}-01`, `${g.m}-02`]), 'M9-00', 'M9-00b'] }

phase('Sync')
await new Promise(resolve => {
  const pump = () => {
    let changed = true
    while (changed) {
      changed = false
      for (const it of I) {
        if (state[it.id] !== 'pending') continue
        const bad = it.deps.find(d => state[d] === 'blocked' || state[d] === 'skipped')
        if (bad) { state[it.id] = 'skipped'; reasons[it.id] = `dependency ${bad} is ${state[bad]}`; changed = true }
      }
    }
    const ready = I.filter(it => state[it.id] === 'pending' && it.deps.every(d => state[d] === 'done') && it.after.every(d => settled(state[d]))).sort((a, b) => a.prio - b.prio)
    while (!halted && running < CAP && ready.length) {
      const it = ready.shift()
      state[it.id] = 'running'; running++
      log(`start ${it.id} (running ${running})`)
      runItem(it).then(async r => {
        state[it.id] = r.status === 'pass' ? 'done' : r.status
        if (r.status === 'error') { halted = true; log(`HALT: ${it.id} errored (${r.reason}); draining running items, then stopping for resume`) }
        if (r.reason) reasons[it.id] = r.reason
        if (r.status === 'blocked' && it.kind !== 'sync' && it.kind !== 'triage') await recordBlocked(it, r.reason)
        log(`finish ${it.id}: ${state[it.id]}${r.reason ? ' — ' + r.reason : ''}`)
        if (REPORT_POINTS[it.id]) summarize('STEP 2/3 REPORT (platform + logic + content + golden)', REPORT_POINTS[it.id])
      }).catch(e => { state[it.id] = 'error'; reasons[it.id] = String(e); halted = true }).finally(() => { running--; pump() })
    }
    if (running === 0 && (halted || !ready.length)) resolve()
  }
  pump()
})

summarize('FINAL REPORT (Wave C + M10 + all)', I.map(x => x.id))
return { halted, state, reasons, disputes }

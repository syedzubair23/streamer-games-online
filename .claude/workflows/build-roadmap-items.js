export const meta = {
  name: 'build-roadmap-items',
  description: 'Build roadmap items in dependency groups; each item loops builder -> harsh independent verifier/critic -> fixer until pass',
  whenToUse: 'Implementing items from docs/ROADMAP.md with critic loops',
  phases: [{ title: 'Build' }, { title: 'Verify' }, { title: 'Fix' }],
}

const ROOT = 'E:/Game/streamer-games-online'
const MAX_ROUNDS = args.maxRounds || 5
const groups = args.groups   // [[{id, visual, note}], ...] groups run sequentially, items within a group in parallel

const HOUSE = `You are working in the monorepo at ${ROOT} (Windows; use the Bash tool with POSIX syntax, pnpm 12, Node 22). Authoritative docs: docs/SPEC.md, docs/ROADMAP.md, docs/DOD.md, docs/specs/*.md, docs/research/*.md, and CLAUDE.md if present. Read the relevant sections for your item before acting.
Rules for parallel work: other agents are working on OTHER roadmap items in the same working tree at the same time. Only edit files your item owns (per ROADMAP "Files"); if you must touch a shared file (root package.json, pnpm-lock, tsconfig refs), make minimal additive edits and re-read before writing. If "pnpm install" fails due to a concurrent lock, wait/retry. Do NOT git commit (the orchestrator commits). Do not weaken tests or lint rules to make things pass. Do not stub or fake functionality that the acceptance criteria require.`

const VERDICT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    score: { type: 'number', description: '0-10 overall quality; for visual items min rubric item score' },
    issues: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
      what: { type: 'string' }, where: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'what', 'fix'] } },
    evidence: { type: 'string', description: 'commands run and their results, screenshots viewed' },
  },
  required: ['pass', 'score', 'issues', 'evidence'],
}

async function doItem(item) {
  const spec = `ROADMAP item ${item.id}. ${item.note || ''} Find its full definition (Goal/Files/Depends/Accept) in docs/ROADMAP.md, plus the Definition of Done in docs/DOD.md.`
  await agent(`${HOUSE}\n\nYou are the BUILDER. Implement ${spec}\nBuild it completely and to a very high standard — production quality, no TODO stubs for anything in scope. Write tests for every acceptance criterion and run them. When finished, write artifacts/verify/${item.id}.json summarizing each acceptance criterion and the command that proves it. Final reply: what you built, what commands pass, anything you could not do.`,
    { label: `build:${item.id}`, phase: 'Build' })
  let last = null
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const v = await agent(`${HOUSE}\n\nYou are an INDEPENDENT, HARSH VERIFIER for ${spec}\nYou did not build it and you do not trust the builder's claims. Re-run every acceptance check yourself (typecheck, lint, tests, the specific commands in Accept, the DoD gates that apply). Read the code for fake/stubbed/hard-coded behaviour, tests that assert nothing, skipped tests, weakened lint, missing files from the "Files" list, and deviation from SPEC.${item.visual ? `\nThis item has VISUALS: run the Playwright screenshot harness (or write a quick Playwright script with the installed chromium if the harness isn't built yet) to capture the relevant screens at desktop 1920x1080 and phone 390x844 in multiple ambient modes, then LOOK at every PNG with the Read tool. Score it with the rubric in docs/DOD.md §4 like a brutal AAA art director — cozy lofi Cozy Table style, polish, readability, composition, lighting, typography, motion evidence. Anything below 8.5 on any rubric item is a fail. Save your report to artifacts/critic/${item.id}/round-${round}.json.` : ''}\nDefault to pass=false if anything required is missing or unverified. Only pass when every acceptance criterion is demonstrably met. List concrete, actionable issues.`,
      { label: `verify:${item.id}#${round}`, phase: 'Verify', schema: VERDICT })
    last = v
    if (!v) break
    log(`${item.id} round ${round}: pass=${v.pass} score=${v.score} issues=${v.issues.length}`)
    if (v.pass) return { id: item.id, pass: true, rounds: round, score: v.score }
    if (round === MAX_ROUNDS) break
    await agent(`${HOUSE}\n\nYou are the BUILDER fixing ${spec}\nAn independent harsh verifier rejected it (round ${round}, score ${v.score}). Fix EVERY issue properly (root cause, no hacks), re-run the checks, update artifacts/verify/${item.id}.json.\nIssues:\n${JSON.stringify(v.issues, null, 1)}\nVerifier evidence:\n${v.evidence}`,
      { label: `fix:${item.id}#${round}`, phase: 'Fix' })
  }
  return { id: item.id, pass: false, rounds: MAX_ROUNDS, score: last && last.score, openIssues: last && last.issues }
}

const results = []
for (const g of groups) {
  log(`Group: ${g.map(i => i.id).join(', ')}`)
  const r = await parallel(g.map(item => () => doItem(item)))
  results.push(...r.filter(Boolean))
}
return results

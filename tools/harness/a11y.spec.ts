/// <reference lib="dom" />
/**
 * G9 accessibility (DOD §2), on the controller and the Stage HUD:
 *
 * - axe (WCAG 2.1 A/AA): 0 serious or critical findings, on every controller scenario and every
 *   stage scenario, in all 5 modes (axe's colour-contrast rule measures the rendered text);
 * - token contrast: each mode's ink clears 4.5:1 on the UI background and surface;
 * - tap targets: every visible control is at least 44×44 px at 360 px width;
 * - reduced motion: with `prefers-reduced-motion: reduce`, playing each scenario fires no
 *   confetti and no shake;
 * - keyboard: a controller state with input is playable with Tab + Enter/Space alone.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { collectErrors, openScenario } from "./src/browser.ts";
import { checkTokenContrast, type UiTokens } from "./src/contrast.ts";
import { PHONE, scenarioPath, STAGE_VIEWPORTS, type Mode, type Viewport } from "./src/matrix.ts";
import { specEnv, writeJson } from "./src/spec-env.ts";

const { game, round, manifest } = specEnv();
const ALL_MODES: readonly Mode[] = ["day", "dusk", "night", "rain", "snow"];
const DESKTOP = STAGE_VIEWPORTS[1] as Viewport;
const listed = manifest.scenarios.filter((s) => s.inSpec && s.registered);
const phoneScenarios = listed.flatMap((s) =>
  (["player", "audience"] as const).filter((r) => s.roles.includes(r)).map((role) => ({ s, role })),
);
const stageScenarios = listed.filter((s) => s.roles.includes("stage"));

type Handle = {
  fx(): { name: string; suppressed: boolean }[];
  sent(): { action: unknown; ok: boolean }[];
  tokens(): { mode: UiTokens };
  players: string[];
  sample(ms: number): Promise<number[]>;
};
const tokensOf = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __SCENE__: Handle }).__SCENE__.tokens().mode);
const playersOf = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __SCENE__: Handle }).__SCENE__.players);
const sentOf = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __SCENE__: Handle }).__SCENE__.sent());
const unsuppressedMotionFx = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as { __SCENE__: Handle }).__SCENE__
      .fx()
      .filter((f) => (f.name === "confetti" || f.name === "shake") && !f.suppressed),
  );
const play = (page: Page, ms: number) =>
  page.evaluate((t) => (globalThis as unknown as { __SCENE__: Handle }).__SCENE__.sample(t), ms);
async function open(browser: Browser, vp: Viewport, path: string, reduced = false) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    reducedMotion: reduced ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await openScenario(page, path);
  return { context, page, errors };
}

async function seriousAxe(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (include !== undefined) builder = builder.include(include);
  const res = await builder.analyze();
  return res.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
}

test.describe(`G9 axe: ${game}`, () => {
  for (const { s, role } of phoneScenarios)
    for (const mode of ALL_MODES)
      test(`G9 axe controller: ${s.id} ${role} ${mode}`, async ({ browser }) => {
        const { context, page, errors } = await open(
          browser,
          PHONE,
          scenarioPath({ game, state: s.id, mode, role, quality: "low", vp: PHONE.label }),
        );
        const violations = await seriousAxe(page);
        await context.close();
        expect(errors).toEqual([]);
        expect(violations, JSON.stringify(violations)).toEqual([]);
      });
  for (const s of stageScenarios)
    for (const mode of ALL_MODES)
      test(`G9 axe stage HUD: ${s.id} ${mode}`, async ({ browser }) => {
        const { context, page, errors } = await open(
          browser,
          DESKTOP,
          scenarioPath({
            game,
            state: s.id,
            mode,
            role: "stage",
            quality: DESKTOP.tier,
            vp: DESKTOP.label,
          }),
        );
        const violations = await seriousAxe(page);
        await context.close();
        expect(errors).toEqual([]);
        expect(violations, JSON.stringify(violations)).toEqual([]);
      });
});

test(`G9 token contrast: ${game} ink ≥ 4.5:1 in every mode`, async ({ browser }) => {
  const s = stageScenarios[0] ?? listed[0];
  expect(s, "no scenario to read tokens from").toBeDefined();
  const results: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const mode of ALL_MODES) {
    const role = s!.roles.includes("stage") ? "stage" : (s!.roles[0] ?? "stage");
    const { context, page } = await open(
      browser,
      DESKTOP,
      scenarioPath({ game, state: s!.id, mode, role }),
    );
    const tokens = await tokensOf(page);
    await context.close();
    const check = checkTokenContrast(tokens);
    results[mode] = check.ratios;
    for (const f of check.failures) failures.push(`${mode} ${f.pair} ${f.ratio}:1`);
  }
  writeJson(`artifacts/screenshots/${game}/round-${round}/meta/a11y-contrast.json`, results);
  expect(failures).toEqual([]);
});

test.describe(`G9 tap targets: ${game}`, () => {
  for (const { s, role } of phoneScenarios)
    test(`G9 tap targets: ${s.id} ${role}`, async ({ browser }) => {
      const { context, page } = await open(
        browser,
        PHONE,
        scenarioPath({ game, state: s.id, mode: "dusk", role, quality: "low", vp: PHONE.label }),
      );
      const small = await page.evaluate(() => {
        const sel =
          "button, a[href], input, select, textarea, [role=button], [role=slider], [role=checkbox], [tabindex]:not([tabindex='-1'])";
        return [...document.querySelectorAll<HTMLElement>(sel)]
          .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === "fixed")
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              label: el.getAttribute("aria-label") ?? el.textContent ?? "",
              w: r.width,
              h: r.height,
            };
          })
          .filter((r) => r.w < 44 || r.h < 44);
      });
      await context.close();
      expect(small, JSON.stringify(small)).toEqual([]);
    });
});

test.describe(`G9 reduced motion: ${game}`, () => {
  for (const s of stageScenarios)
    test(`G9 reduced motion: ${s.id} fires no confetti or shake`, async ({ browser }) => {
      const { context, page, errors } = await open(
        browser,
        DESKTOP,
        scenarioPath({
          game,
          state: s.id,
          mode: "dusk",
          role: "stage",
          quality: "high",
          vp: DESKTOP.label,
          ...(s.anim !== null ? { freeze: false, play: "anim" as const } : {}),
        }),
        true,
      );
      // One full animation cycle (the route holds the end pose for half the duration, min 400 ms).
      if (s.anim !== null) await play(page, Math.round(s.anim.durationMs * 1.5) + 400);
      const fired = await unsuppressedMotionFx(page);
      await context.close();
      expect(errors).toEqual([]);
      expect(fired, "confetti/shake ran with reduced motion").toEqual([]);
    });
});

test(`G9 keyboard: ${game} controller is playable by keyboard`, async ({ browser }) => {
  const players = phoneScenarios.filter((x) => x.role === "player");
  expect(players.length, "the spec lists no player scenario").toBeGreaterThan(0);
  const tried: string[] = [];
  for (const { s } of players) {
    const first = await open(
      browser,
      DESKTOP,
      scenarioPath({ game, state: s.id, mode: "dusk", role: "player" }),
    );
    const ids = await playersOf(first.page);
    await first.context.close();
    for (const id of ids.length > 0 ? ids : [undefined]) {
      const { context, page } = await open(
        browser,
        DESKTOP,
        scenarioPath({
          game,
          state: s.id,
          mode: "dusk",
          role: "player",
          ...(id !== undefined ? { player: id } : {}),
        }),
      );
      tried.push(`${s.id}${id !== undefined ? `/${id}` : ""}`);
      const enabled = await page
        .locator(
          "button:not([disabled]), input:not([disabled]), [role=button]:not([aria-disabled=true])",
        )
        .count();
      if (enabled === 0) {
        await context.close();
        continue;
      }
      let focused = false;
      for (let i = 0; i < 60 && !focused; i++) {
        await page.keyboard.press("Tab");
        focused = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return (
            el !== null &&
            el.matches("button:not([disabled]), [role=button]:not([aria-disabled=true])")
          );
        });
      }
      if (!focused) {
        await context.close();
        continue;
      }
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      const sent = await sentOf(page);
      await context.close();
      if (sent.some((x) => x.ok)) {
        writeJson(`artifacts/screenshots/${game}/round-${round}/meta/a11y-keyboard.json`, {
          scenario: s.id,
          player: id ?? null,
          sent,
        });
        return;
      }
    }
  }
  throw new Error(`no controller state was playable by keyboard (tried ${tried.join(", ")})`);
});

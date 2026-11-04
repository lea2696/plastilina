import { test, expect, type Page } from '@playwright/test';
import {
  app, diagnostics, isSubsequence, launchUntilRolling, mark, num, openAdvanced, openDiagnostics, phasesAfterRounds, phasesOf, playRound,
  pollDiagnostics, PRESS_AT, saveJson, shot, sleep, traceOf, TWO_ROUNDS, tugDrag, valuesOf, visit, waitForPhase,
  watchProblems, yoyoOnScreen, type RoundResult,
} from './yoyo-ui';

/**
 * Pointer route (PRD §4.5): the mouse IS the hand. Evidence label: sintético (a person-less pointer through the real
 * page, real WebGL, real audio, real clock). The gestures are sent with Playwright's mouse; see LAUNCH and TUG in
 * yoyo-ui.ts for why their events are shaped the way they are.
 */

/** What the pill says in each phase of a pointer session. */
const PILL = {
  hint: 'Mantené apretado · arrastrá rápido hacia abajo para lanzar · hacia arriba para tirar',
  tethered: 'Atado · lanzá hacia abajo',
  rolling: 'Rodando',
  sleeping: 'Durmiendo · tirá para que vuelva',
  returning: 'Enrollando',
  caught: '¡Atrapado!',
  exhausted: 'Giro agotado · tirá para enrollar',
} as const;

/** «Ajustes» → «Avanzado»: the slider of a tunable, set to its minimum with the keyboard (real input events, which React reads). */
async function setSliderToMin(page: Page, label: string, expected: string): Promise<void> {
  const slider = page.getByRole('slider', { name: label, exact: true });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveValue(expected);
}

/** Presses the button on the stage and waits for the yoyo to tie on: the start of every pointer session. */
async function pressAndTieOn(page: Page): Promise<{ pressedAt: number; tetheredAt: number }> {
  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  const pressedAt = await mark(page, 'press');
  await page.mouse.down();
  const tethered = await waitForPhase(page, 'tethered', { timeout: 5_000 });
  return { pressedAt, tetheredAt: tethered.t };
}

test('[sintético: puntero] Y-11 + Y-01..Y-05: three rounds by pointer walk tethered → rolling → sleeping → returning → caught → tethered', async ({ page }) => {
  test.setTimeout(120_000);
  const watch = watchProblems(page);
  await visit(page);

  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'mouse');
  await expect(app(page)).toHaveAttribute('data-source', 'mouse');
  await expect(page.getByRole('status')).toHaveText(PILL.hint);

  // Y-01 (pointer): the yoyo ties on after the hand has been still for 400 ms and no later than a second, never before.
  const { pressedAt, tetheredAt } = await pressAndTieOn(page);
  const tieOnMs = tetheredAt - pressedAt;
  expect(tieOnMs).toBeGreaterThanOrEqual(380);
  expect(tieOnMs).toBeLessThanOrEqual(1_000);
  await expect(page.getByRole('status')).toHaveText(PILL.tethered);
  await shot(page, 'mouse-1-tethered');

  // Y-02 (pointer): 5 s with the hand still launch nothing.
  const stillFrom = (await traceOf(page)).length;
  await sleep(5_000);
  expect(valuesOf(await traceOf(page), 'data-phase', stillFrom)).toEqual([]);

  // Three rounds in a row, the button held the whole time. The first one is photographed phase by phase.
  const rounds: RoundResult[] = [];
  const yoyoAtSleep: Array<ReturnType<typeof yoyoOnScreen>> = [];
  for (let i = 0; i < 3; i++) {
    const result = await playRound(page, PRESS_AT, {
      onPhase: async phase => {
        if (i > 0 && phase !== 'sleeping') return;
        if (phase === 'sleeping') await sleep(400);
        const png = await shot(page, `mouse-${{ rolling: 2, sleeping: 3, returning: 4, caught: 5, exhausted: 9 }[phase]}-${phase}${i > 0 ? `-round${i + 1}` : ''}`);
        if (phase === 'sleeping') yoyoAtSleep.push(yoyoOnScreen(png));
      },
    });
    rounds.push(result);
    expect(phasesOf(await traceOf(page)), `after round ${i + 1}`).toEqual(phasesAfterRounds(i + 1));
  }

  // The harness cannot send pointer events faster than the browser's frame (see LAUNCH in yoyo-ui.ts): a gesture that was not
  // read is made again, and that may happen once in a while, never twice in a row. The attempts go in the evidence file.
  for (const [i, r] of rounds.entries()) {
    expect(r.launchAttempts, `launch attempts in round ${i + 1}`).toBeLessThanOrEqual(2);
    expect(r.tugAttempts, `tug attempts in round ${i + 1}`).toBeLessThanOrEqual(2);
    expect(r.launchRepresses, `the page kept the hand through round ${i + 1}`).toBe(0);
  }

  // The sequence is the same one the demo and the camera replay walk (Y-11), and the app's own trail agrees with it.
  const trace = await traceOf(page);
  const expected = phasesAfterRounds(3);
  expect(phasesOf(trace)).toEqual(expected);
  expect(phasesOf(trace).slice(0, TWO_ROUNDS.length)).toEqual([...TWO_ROUNDS]);
  expect((await app(page).getAttribute('data-trail'))?.split(' ')).toEqual(expected.slice(-16));
  expect(isSubsequence([PILL.tethered, PILL.rolling, PILL.sleeping, PILL.returning, PILL.caught, PILL.tethered], valuesOf(trace, 'pill'))).toBe(true);

  // The hand was present for the whole game (nothing was lost, nothing teleported off screen) and the yoyo was on screen
  // at every sleep: above the floor line, with a body's worth of pixels.
  expect(valuesOf(trace, 'data-hand')).toEqual(['present']);
  expect(yoyoAtSleep).toHaveLength(3);
  for (const [i, pixels] of yoyoAtSleep.entries()) {
    expect(pixels.count, `yoyo pixels at sleep ${i + 1}`).toBeGreaterThan(1_500);
    expect(pixels.box!.maxY, `yoyo bottom at sleep ${i + 1}`).toBeLessThan(pixels.height * 0.93);
    expect(pixels.box!.minY).toBeGreaterThan(0);
  }

  // Releasing the button ends the hand but not the game: the yoyo stays on the finger and the pill says how to hold again.
  await page.mouse.up();
  await expect(app(page)).toHaveAttribute('data-hand', 'lost');
  await expect(app(page)).toHaveAttribute('data-phase', 'tethered');
  await expect(page.getByRole('status')).toHaveText(PILL.hint);
  await shot(page, 'mouse-6-released');

  // Y-10 (pointer, informative here; the budgets are asserted in yoyo-performance): counts and a latency sample per intent.
  await openDiagnostics(page);
  const d = await pollDiagnostics(page, x => x.launches === 3 && x.tugs === 3 && x.catches === 3);
  expect(d.source).toBe('mouse');
  expect(num(d, 'latencySamples')).toBeGreaterThanOrEqual(6);
  expect(num(d, 'latencyP50Ms')).toBeLessThanOrEqual(100);
  expect(num(d, 'latencyP95Ms')).toBeLessThanOrEqual(100);
  expect(d.autoReturns).toBe(0);
  expect(d.queueDrops).toBe(0);
  await shot(page, 'mouse-7-diagnostics');

  saveJson('mouse', {
    kind: 'sintético: puntero (Playwright mouse) sobre la página real',
    tieOnMs: Math.round(tieOnMs),
    rounds: rounds.map(r => ({
      launchAttempts: r.launchAttempts,
      tugAttempts: r.tugAttempts,
      launchRepresses: r.launchRepresses,
      launchGestureToRollingMs: Math.round(r.phaseAt.rolling - r.launchEndedAt),
      tugGestureToReturningMs: Math.round(r.phaseAt.returning - r.tugEndedAt),
      rollingMs: Math.round(r.phaseAt.sleeping - r.phaseAt.rolling),
      returningMs: Math.round(r.phaseAt.caught - r.phaseAt.returning),
      caughtMs: Math.round(r.phaseAt.tethered - r.phaseAt.caught),
    })),
    yoyoPixelsAtSleep: yoyoAtSleep,
    diagnostics: d,
  });
  expect(watch.problems).toEqual([]);
});

test('[sintético: puntero] Y-08: auto-return off and the spin at its shortest: «Giro agotado · tirá para enrollar», it hangs there, a tug brings it back', async ({ page }) => {
  test.setTimeout(90_000);
  const watch = watchProblems(page);
  await visit(page);

  // The tunables are set from the start screen: the runtime that «Probar con mouse» builds reads them.
  await openAdvanced(page);
  await setSliderToMin(page, 'Duración del giro (τ)', '1');
  await expect(page.getByRole('spinbutton', { name: 'Duración del giro (τ), valor' })).toHaveValue('1.0');
  await sleep(300);
  await shot(page, 'mouse-y08-advanced-tau');
  const autoReturn = page.getByRole('switch', { name: 'Auto-retorno' });
  await autoReturn.scrollIntoViewIfNeeded();
  await expect(autoReturn).toBeChecked();
  await autoReturn.uncheck();
  await expect(autoReturn).not.toBeChecked();
  await sleep(300);   // the switch slides for 0.2 s
  await shot(page, 'mouse-y08-advanced-switch');
  await page.getByRole('button', { name: 'Ajustes' }).click();   // out of the way of the stage

  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await pressAndTieOn(page);

  let hung: string[] | null = null;
  const round = await playRound(page, PRESS_AT, {
    waitFor: 'exhausted',
    onPhase: async phase => {
      if (phase !== 'exhausted') return;
      // Y-08: a defined state. It hangs (no phase change of its own for two seconds), says what to do, and is on screen.
      await expect(page.getByRole('status')).toHaveText(PILL.exhausted);
      const png = await shot(page, 'mouse-8-exhausted');
      const pixels = yoyoOnScreen(png);
      expect(pixels.count).toBeGreaterThan(1_500);
      expect(pixels.box!.maxY).toBeLessThan(pixels.height * 0.93);
      const from = (await traceOf(page)).length;
      await sleep(2_000);
      hung = valuesOf(await traceOf(page), 'data-phase', from);
      await expect(page.getByRole('status')).toHaveText(PILL.exhausted);
    },
  });
  expect(hung).toEqual([]);
  expect(round.tugAttempts).toBeGreaterThanOrEqual(1);

  // The tug of an exhausted yoyo winds it in and it is caught (the playRound waited for returning, caught, tethered).
  expect(phasesOf(await traceOf(page))).toEqual(['untethered', 'tethered', 'rolling', 'sleeping', 'exhausted', 'returning', 'caught', 'tethered']);
  await page.mouse.up();
  await openDiagnostics(page);
  const d = await pollDiagnostics(page, x => x.catches === 1);
  expect(d.launches).toBe(1);
  expect(d.tugs).toBe(1);
  expect(d.autoReturns).toBe(0);
  expect(watch.problems).toEqual([]);
});

test('[sintético: puntero] with the spin at its shortest and auto-return ON the yoyo comes back by itself (the switch is what made Y-08 hang)', async ({ page }) => {
  test.setTimeout(60_000);
  const watch = watchProblems(page);
  await visit(page);
  await openAdvanced(page);
  await setSliderToMin(page, 'Duración del giro (τ)', '1');
  await expect(page.getByRole('switch', { name: 'Auto-retorno' })).toBeChecked();
  await page.getByRole('button', { name: 'Ajustes' }).click();

  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await pressAndTieOn(page);
  const { rolling } = await launchUntilRolling(page, PRESS_AT);
  const from = rolling.index;
  await waitForPhase(page, 'sleeping', { from, timeout: 6_000 });
  // Nobody tugs: the spin runs out and the yoyo winds itself in.
  const returning = await waitForPhase(page, 'returning', { from, timeout: 15_000 });
  const caught = await waitForPhase(page, 'caught', { from: returning.index, timeout: 6_000 });
  await waitForPhase(page, 'tethered', { from: caught.index, timeout: 3_000 });
  expect(phasesOf(await traceOf(page))).toEqual(['untethered', 'tethered', 'rolling', 'sleeping', 'returning', 'caught', 'tethered']);
  await page.mouse.up();
  await openDiagnostics(page);
  const d = await pollDiagnostics(page, x => x.catches === 1);
  expect(d.autoReturns).toBe(1);
  expect(d.tugs).toBe(0);
  expect(watch.problems).toEqual([]);
});

test('[sintético: puntero] unresponsive mode (experimental): the tug does not bring it back, the pill says so, the yoyo ends exhausted', async ({ page }) => {
  test.setTimeout(90_000);
  const watch = watchProblems(page);
  await visit(page);
  await openAdvanced(page);
  await setSliderToMin(page, 'Duración del giro (τ)', '1');
  const unresponsive = page.getByRole('switch', { name: 'Modo no responsivo (experimental)' });
  await expect(unresponsive).not.toBeChecked();
  await unresponsive.check();
  await expect(unresponsive).toBeChecked();
  await page.getByRole('button', { name: 'Ajustes' }).click();

  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await pressAndTieOn(page);
  const { rolling, position: afterLaunch } = await launchUntilRolling(page, PRESS_AT);
  const from = rolling.index;
  await waitForPhase(page, 'sleeping', { from, timeout: 6_000 });
  await expect(page.getByRole('status')).toHaveText('Durmiendo · sin retorno');

  // A tug that would bring a responsive yoyo back does nothing here.
  await sleep(700);
  const beforeTug = (await traceOf(page)).length;
  const afterTug = await tugDrag(page, afterLaunch);
  await sleep(1_500);
  expect(valuesOf(await traceOf(page), 'data-phase', beforeTug)).toEqual([]);
  await shot(page, 'mouse-unresponsive-sleeping');

  // Without a bind (a later phase) it ends exhausted, and a second tug is ignored too.
  await waitForPhase(page, 'exhausted', { from, timeout: 15_000 });
  await expect(page.getByRole('status')).toHaveText('Giro agotado · sin retorno');
  await sleep(700);
  const beforeSecond = (await traceOf(page)).length;
  await tugDrag(page, afterTug);
  await sleep(1_500);
  expect(valuesOf(await traceOf(page), 'data-phase', beforeSecond)).toEqual([]);
  expect(phasesOf(await traceOf(page))).toEqual(['untethered', 'tethered', 'rolling', 'sleeping', 'exhausted']);
  await page.mouse.up();
  await openDiagnostics(page);
  const d = await diagnostics(page);
  expect(d.tugs).toBe(0);
  expect(d.catches).toBe(0);
  expect(d.autoReturns).toBe(0);
  expect(watch.problems).toEqual([]);
});

test('[sintético: puntero] settings: colour, posture, pause and resume, back to the start, reset, Escape', async ({ page }) => {
  test.setTimeout(60_000);
  const watch = watchProblems(page);
  await visit(page);
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'mouse');

  await page.getByRole('button', { name: 'Ajustes' }).click();
  const colours = page.getByRole('radiogroup', { name: 'Color del yoyó' });
  await colours.getByRole('radio', { name: 'Azul' }).click();
  await expect(colours.getByRole('radio', { name: 'Azul' })).toHaveAttribute('aria-checked', 'true');
  await expect(colours.getByRole('radio', { name: 'Rojo' })).toHaveAttribute('aria-checked', 'false');

  // Posture is one choice of two.
  const posture = page.getByRole('group', { name: 'Postura' });
  await expect(posture.getByRole('button', { name: 'De pie' })).toHaveAttribute('aria-pressed', 'true');
  await posture.getByRole('button', { name: 'Sentado' }).click();
  await expect(posture.getByRole('button', { name: 'Sentado' })).toHaveAttribute('aria-pressed', 'true');
  await expect(posture.getByRole('button', { name: 'De pie' })).toHaveAttribute('aria-pressed', 'false');
  await posture.getByRole('button', { name: 'De pie' }).click();

  // What needs a camera is there but disabled: the panel does not rearrange itself between sources.
  await expect(page.getByRole('button', { name: 'Recalibrar' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Apagar cámara' })).toBeDisabled();

  // Tie on, then let go: the yoyo stays on the finger.
  const first = await pressAndTieOn(page);
  expect(first.tetheredAt - first.pressedAt).toBeLessThanOrEqual(1_000);
  await page.mouse.up();
  await expect(app(page)).toHaveAttribute('data-hand', 'lost');

  // Pause: nothing is handled while paused, the frozen yoyo stays on screen, and a hand pressed during it is ignored.
  await page.getByRole('button', { name: 'Pausar' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'paused');
  await expect(page.getByRole('status')).toHaveText('Pausa');
  await expect(page.getByRole('button', { name: 'Reanudar' })).toBeVisible();
  const pausedFrom = (await traceOf(page)).length;
  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  await page.mouse.down();
  await sleep(900);
  await expect(app(page)).toHaveAttribute('data-hand', 'lost');
  expect(valuesOf(await traceOf(page), 'data-phase', pausedFrom)).toEqual([]);
  await page.mouse.up();
  const pausedPixels = yoyoOnScreen(await shot(page, 'mouse-paused'), '#3b7bff');
  expect(pausedPixels.count).toBeGreaterThan(1_000);
  await page.getByRole('button', { name: 'Reanudar' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'mouse');

  // After resuming the hand counts again.
  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  await page.mouse.down();
  await expect(app(page)).toHaveAttribute('data-hand', 'present');
  await page.mouse.up();

  // «Restablecer» puts every tunable and both switches back to their defaults.
  await openAdvanced(page);
  await setSliderToMin(page, 'Duración del giro (τ)', '1');
  await page.getByRole('switch', { name: 'Auto-retorno' }).uncheck();
  await page.getByRole('button', { name: 'Restablecer' }).click();
  await expect(page.getByRole('slider', { name: 'Duración del giro (τ)', exact: true })).toHaveValue('4');
  await expect(page.getByRole('switch', { name: 'Auto-retorno' })).toBeChecked();
  await shot(page, 'mouse-settings');

  // Escape closes the settings; «Volver al inicio» ends the pointer session and brings the start screen back.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Pausar' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByRole('button', { name: 'Volver al inicio' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'idle');
  await expect(app(page)).toHaveAttribute('data-source', 'none');
  await expect(page.getByRole('button', { name: 'Comenzar con cámara' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Probar con mouse' })).toBeVisible();
  expect(watch.problems).toEqual([]);
});

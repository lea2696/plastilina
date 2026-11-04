import { test, expect, type Page } from '@playwright/test';
import { openSettings } from './ui';
import { app, launchUntilRolling, PRESS_AT, saveJson, sleep, visit, waitForPhase, watchProblems } from './yoyo-ui';

/**
 * Procedural audio (PRD §6). Evidence label: sintético. A spy on the Web Audio constructors sees what the page builds;
 * nothing here listens to the sound itself (that is `pnpm test:yoyo:audio`, offline and live, and a person's ears).
 */

interface AudioSnapshot {
  constructed: number;
  /** Was the page's user activation active when each context was constructed (i.e. built inside a click)? */
  userActive: boolean[];
  states: string[];
  oscillators: number;
  bufferSources: number;
  /** What was asked of the master gain (the first GainNode of the context): the volume × mute chain. */
  masterCalls: Array<{ method: string; value: number }>;
}

declare global {
  interface Window {
    __audioSpy?: {
      constructed: number;
      userActive: boolean[];
      contexts: AudioContext[];
      oscillators: number;
      bufferSources: number;
      masterCalls: Array<{ method: string; value: number }>;
    };
  }
}

/** Wraps AudioContext (and the prefixed name) so the page's construction, nodes and master gain are observable. Call before `goto`. */
async function installAudioSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spy = { constructed: 0, userActive: [] as boolean[], contexts: [] as AudioContext[], oscillators: 0, bufferSources: 0, masterCalls: [] as Array<{ method: string; value: number }> };
    window.__audioSpy = spy;
    const Native = window.AudioContext;
    class Spied extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        spy.constructed++;
        spy.userActive.push(navigator.userActivation?.isActive ?? false);
        spy.contexts.push(this);
        let gains = 0;
        const createGain = this.createGain.bind(this);
        this.createGain = (): GainNode => {
          const node = createGain();
          // The master chain (volume × mute → limiter → destination) is built first, so its gain is the context's first.
          if (gains++ === 0) {
            const param = node.gain;
            const setValueAtTime = param.setValueAtTime.bind(param);
            param.setValueAtTime = (value: number, startTime: number) => { spy.masterCalls.push({ method: 'setValueAtTime', value }); return setValueAtTime(value, startTime); };
            const setTargetAtTime = param.setTargetAtTime.bind(param);
            param.setTargetAtTime = (target: number, startTime: number, timeConstant: number) => { spy.masterCalls.push({ method: 'setTargetAtTime', value: target }); return setTargetAtTime(target, startTime, timeConstant); };
          }
          return node;
        };
        const createOscillator = this.createOscillator.bind(this);
        this.createOscillator = (): OscillatorNode => { spy.oscillators++; return createOscillator(); };
        const createBufferSource = this.createBufferSource.bind(this);
        this.createBufferSource = (): AudioBufferSourceNode => { spy.bufferSources++; return createBufferSource(); };
      }
    }
    window.AudioContext = Spied;
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext = Spied;
  });
}

async function audio(page: Page): Promise<AudioSnapshot> {
  return page.evaluate(() => {
    const spy = window.__audioSpy!;
    return {
      constructed: spy.constructed,
      userActive: [...spy.userActive],
      states: spy.contexts.map(context => context.state),
      oscillators: spy.oscillators,
      bufferSources: spy.bufferSources,
      masterCalls: spy.masterCalls.map(call => ({ ...call })),
    };
  });
}

/** Master gain for a volume, as the page documents it: 0.7 × volume² (YoyoAudioGraph.masterGainFor). */
const master = (volume: number): number => 0.7 * volume * volume;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

test('[sintético: audio] no AudioContext exists until the first click on a start button; «Probar con mouse» builds exactly one, inside the click, and it runs', async ({ page }) => {
  const watch = watchProblems(page);
  await installAudioSpy(page);
  await visit(page);
  await sleep(2_000);
  expect((await audio(page)).constructed).toBe(0);

  // Looking around the page is not a start: the settings, the colours, a click on the empty stage.
  await page.getByRole('radiogroup', { name: 'Color del yoyó' }).getByRole('radio', { name: 'Violeta' }).click();
  await openSettings(page);
  await page.getByRole('button', { name: 'Avanzado' }).click();
  await page.mouse.click(700, 300);
  await sleep(500);
  expect((await audio(page)).constructed).toBe(0);

  // The start click builds it, within the gesture (so the browser lets it run), once.
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await expect.poll(async () => (await audio(page)).constructed).toBe(1);
  const afterClick = await audio(page);
  expect(afterClick.userActive).toEqual([true]);
  await expect.poll(async () => (await audio(page)).states[0]).toBe('running');
  // The default volume (0.8, «moderado») is on the master gain from the first moment.
  expect(afterClick.masterCalls.some(call => call.method === 'setTargetAtTime' && near(call.value, master(0.8)))).toBe(true);

  // Pressing the stage (more clicks) does not build another.
  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(300);
  expect((await audio(page)).constructed).toBe(1);
  expect(watch.problems).toEqual([]);
});

test('[sintético: audio] the volume slider and «Silenciar» reach the master gain with the documented taper; they work without errors', async ({ page }) => {
  const watch = watchProblems(page);
  await installAudioSpy(page);
  await visit(page);
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await expect.poll(async () => (await audio(page)).states[0]).toBe('running');
  await openSettings(page);

  const volume = page.getByRole('slider', { name: 'Volumen' });
  await expect(volume).toHaveValue('80');
  await volume.fill('35');
  await expect(volume).toHaveValue('35');
  await expect.poll(async () => (await audio(page)).masterCalls.some(call => call.method === 'setTargetAtTime' && near(call.value, master(0.35)))).toBe(true);
  await volume.fill('0');
  await expect.poll(async () => (await audio(page)).masterCalls.some(call => call.method === 'setTargetAtTime' && call.value === 0)).toBe(true);
  await volume.fill('35');

  // Mute is immediate (a hard set to 0) and says so on the button; unmute eases back to the chosen volume.
  const callsBefore = (await audio(page)).masterCalls.length;
  await page.getByRole('button', { name: 'Silenciar' }).click();
  await expect(page.getByRole('button', { name: 'Activar sonido' })).toBeVisible();
  await expect.poll(async () => (await audio(page)).masterCalls.slice(callsBefore).some(call => call.method === 'setValueAtTime' && call.value === 0)).toBe(true);
  await expect(volume).toHaveValue('35');
  const mutedAt = (await audio(page)).masterCalls.length;
  await page.getByRole('button', { name: 'Activar sonido' }).click();
  await expect(page.getByRole('button', { name: 'Silenciar' })).toBeVisible();
  await expect.poll(async () => (await audio(page)).masterCalls.slice(mutedAt).some(call => call.method === 'setTargetAtTime' && near(call.value, master(0.35)))).toBe(true);

  // The choice survives the end of a session and the start of another one (and no second context is built for it).
  await page.getByRole('button', { name: 'Silenciar' }).click();
  await page.getByRole('button', { name: 'Volver al inicio' }).click();
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'mouse');
  await expect(page.getByRole('button', { name: 'Activar sonido' })).toBeVisible();
  await expect(volume).toHaveValue('35');
  expect((await audio(page)).constructed).toBe(1);
  expect(watch.problems).toEqual([]);
});

test('[sintético: audio] a round of play makes sound (hum and one-shots are built), muting makes none, and a hidden tab suspends the context', async ({ page }) => {
  test.setTimeout(60_000);
  const watch = watchProblems(page);
  await installAudioSpy(page);
  await visit(page);
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await expect.poll(async () => (await audio(page)).states[0]).toBe('running');

  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  await page.mouse.down();
  await waitForPhase(page, 'tethered', { timeout: 5_000 });
  const idle = await audio(page);
  const launched = await launchUntilRolling(page, PRESS_AT);
  await waitForPhase(page, 'sleeping', { from: launched.rolling.index, timeout: 6_000 });
  await sleep(600);
  const playing = await audio(page);
  // The throw's whoosh (filtered noise) and the rolling hum (oscillators with harmonics).
  expect(playing.bufferSources).toBeGreaterThan(idle.bufferSources);
  expect(playing.oscillators).toBeGreaterThan(idle.oscillators);

  // Hidden tab: the page asks for silence, and gets the context suspended; coming back resumes it.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await audio(page)).states[0]).toBe('suspended');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await audio(page)).states[0]).toBe('running');

  // Muted: the same gestures build nothing (events that arrive while muted are dropped, not queued).
  await page.mouse.up();
  await openSettings(page);
  await page.getByRole('button', { name: 'Silenciar' }).click();
  await page.getByRole('button', { name: 'Volver al inicio' }).click();
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  const mutedStart = await audio(page);
  await page.mouse.move(PRESS_AT.x, PRESS_AT.y);
  await page.mouse.down();
  await waitForPhase(page, 'tethered', { timeout: 5_000 });
  const mutedLaunch = await launchUntilRolling(page, PRESS_AT);
  await waitForPhase(page, 'sleeping', { from: mutedLaunch.rolling.index, timeout: 6_000 });
  await sleep(600);
  const mutedPlay = await audio(page);
  expect(mutedPlay.oscillators).toBe(mutedStart.oscillators);
  expect(mutedPlay.bufferSources).toBe(mutedStart.bufferSources);
  await page.mouse.up();

  saveJson('audio', {
    kind: 'sintético: espía de Web Audio en la página real (no se escucha el sonido)',
    contextsBuilt: mutedPlay.constructed,
    builtInsideAClick: mutedPlay.userActive,
    oneRoundOfPlay: { oscillatorsBuilt: playing.oscillators - idle.oscillators, bufferSourcesBuilt: playing.bufferSources - idle.bufferSources },
    whileMuted: { oscillatorsBuilt: mutedPlay.oscillators - mutedStart.oscillators, bufferSourcesBuilt: mutedPlay.bufferSources - mutedStart.bufferSources },
    masterGainCalls: mutedPlay.masterCalls.slice(0, 12),
  });
  expect(watch.problems).toEqual([]);
});

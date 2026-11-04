import { test, expect } from '@playwright/test';
import { openSettings } from './ui';

/** Mouse stand-in for hands: no camera involved. Verifies press and grab reach the solver and leave a mark. */
test('mouse mode presses and grabs the clay without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Probar con mouse' }).click();
  await expect(page.getByRole('status')).toContainText('Modo mouse activo', { timeout: 6000 });
  await openSettings(page);await page.getByRole('button', { name: 'Diagnóstico' }).click();
  const box = (await page.locator('canvas').boundingBox())!;
  // The settled clay sits at the studio origin, near the canvas centre.
  const x = box.x + box.width / 2, y = box.y + box.height * 0.46;
  const shot = async (name: string) => { if (process.env.MASA_SHOTS) await page.screenshot({ path: `${process.env.MASA_SHOTS}/${name}.png` }); };

  await page.mouse.move(x - 40, y);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 25; i++) { await page.mouse.move(x - 40 + i * 3, y); await page.waitForTimeout(30); }
  await expect(page.locator('output')).toContainText(/"contacts":[1-9]/, { timeout: 2000 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(800);
  await shot('mouse-1-press');

  await page.mouse.move(x, y - 50);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) { await page.mouse.move(x, y - 50 - i * 6); await page.waitForTimeout(25); }
  await expect(page.locator('output')).toContainText('"grasps":1', { timeout: 2000 });
  await shot('mouse-2-grab');
  await page.mouse.up();
  await page.waitForTimeout(1500);
  await shot('mouse-3-released');
  const stats = JSON.parse(await page.locator('output').textContent() ?? '{}');
  expect(stats.grasps).toBe(0);
  expect(stats.invertedTets).toBe(0);
  expect(stats.totalContacts).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

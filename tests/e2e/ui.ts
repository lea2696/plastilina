import type { Page } from '@playwright/test';

/** Secondary controls live behind the "Ajustes" toggle; open it if it is closed. */
export async function openSettings(page: Page) {
  const toggle = page.getByRole('button', { name: 'Ajustes' });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

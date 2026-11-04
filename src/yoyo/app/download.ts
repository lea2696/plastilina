/** Delay before the object URL is revoked, so the browser has started the download (same as the replay download). */
const REVOKE_DELAY_MS = 1_000;

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * `yoyo-replay-20261001-165912.json`: the local time of the click, in the name of the file the person
 * saves and nowhere inside it (the files carry no wall-clock date, PRD §8.3).
 */
export function timestampedFilename(prefix: string, extension = 'json', date: Date = new Date()): string {
  const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`;
  const time = `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  return `${prefix}-${day}-${time}.${extension}`;
}

/**
 * Hands a JSON document to the user as a local download: Blob, object URL and a temporary `<a download>`.
 * Nothing is sent anywhere, and it is only ever called from an explicit click. `doc` and `urls` are
 * injectable so the flow can be tested without a browser.
 */
export function downloadJson(
  data: unknown,
  filename: string,
  doc: Document = document,
  urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
): void {
  const url = urls.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  doc.body.appendChild(link);
  link.click();
  doc.body.removeChild(link);
  setTimeout(() => urls.revokeObjectURL(url), REVOKE_DELAY_MS);
}

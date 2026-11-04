/**
 * Shape of the string for rendering. Taut: a straight line. Slack: a sagging curve whose arc length
 * equals the exposed string length, so a slack string looks like the same rope with the ends brought
 * together instead of a shorter one.
 *
 * Why a parabola and not a catenary: both are the same to the eye at these sags, but a parabola with a
 * perpendicular bow has an exact closed-form arc length, needs no special case when the chord is
 * vertical (a catenary degenerates there) and stays finite when the two ends coincide. The bow is
 * measured perpendicular to the chord and points down, because a slack string sags under gravity.
 */

/** A chord whose x component is below this share of its length is "vertical": gravity gives no side. */
const VERTICAL_BAND = 0.12;
/** Bisection steps for the bow: 2⁻⁴⁸ of the bracket, far below a pixel, with a fixed worst-case cost. */
const BISECTION_STEPS = 48;
/** Below this slope the arc-length formula is evaluated by its series (asinh(k)/k is 0/0 at k = 0). */
const SERIES_BELOW = 1e-6;

/**
 * Arc length of a parabola divided by its chord, as a function of k = 4h/d, the slope at the ends.
 * Derivation: x along the chord, y = 4h·(x/d)(1 − x/d), so y' = k(1 − 2x/d) and
 * s = ∫√(1 + y'²)dx = d·∫₀¹√(1 + k²w²)dw = (d/2)·(√(1 + k²) + asinh(k)/k).
 */
function arcRatio(k: number): number {
  if (k < SERIES_BELOW) return 1 + (k * k) / 6;
  return 0.5 * (Math.sqrt(1 + k * k) + Math.asinh(k) / k);
}

/**
 * Bow (maximum perpendicular sag, m) of the parabola with the given chord whose arc length is
 * `arcLength`. Zero when the string is taut or shorter than the chord. Finite for any input: a zero
 * chord yields a string doubled back on itself (bow = s/2) and non-finite input yields 0.
 */
export function parabolaBow(chord: number, arcLength: number): number {
  if (!Number.isFinite(chord) || !Number.isFinite(arcLength) || arcLength <= 0) return 0;
  if (chord <= 1e-9) return arcLength / 2;
  const ratio = arcLength / chord;
  if (ratio <= 1) return 0;
  // arcRatio is increasing in k and arcRatio(2·ratio) ≥ ratio, so [0, 2·ratio] always brackets the root.
  let lo = 0;
  let hi = 2 * ratio;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (arcRatio(mid) < ratio) lo = mid; else hi = mid;
  }
  // Never more than half the string: the fully doubled-back limit of the parabola.
  return Math.min(((lo + hi) / 2) * chord / 4, arcLength / 2);
}

/**
 * Writes `count` points (x, y interleaved) of the string from A to B into `out`.
 *
 * `arcLength` is the length the curve should have: pass the chord (or less) for a straight string.
 * `first` is the index of the first point to write (so the curve can follow other points in the same
 * buffer without a copy). `signHint` (+1 or −1, 0 for none) picks the side of the bow when the chord is near vertical, so the
 * bow does not flip sides frame to frame. `floorY` keeps interior points from sinking under the floor:
 * a slack string lies on it. The endpoints are written exactly. Returns the bow side used (±1).
 */
export function sampleString(
  out: number[] | Float32Array,
  count: number,
  ax: number, ay: number,
  bx: number, by: number,
  arcLength: number,
  signHint: number,
  floorY: number,
  first = 0,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const chord = Math.hypot(dx, dy);
  // Chord direction; a coincident pair hangs straight down so the bow still has an orientation.
  const cx = chord > 1e-9 ? dx / chord : 0;
  const cy = chord > 1e-9 ? dy / chord : -1;
  let sign: number;
  if (Math.abs(cx) < VERTICAL_BAND && signHint !== 0) sign = signHint > 0 ? 1 : -1;
  else sign = cx > 0 ? -1 : 1;
  // sign·(−cy, cx) is the unit perpendicular; its y component is sign·cx, kept ≤ 0 (pointing down).
  const nx = sign * -cy;
  const ny = sign * cx;
  const bow = parabolaBow(chord, arcLength);
  const last = count - 1;
  for (let i = 0; i < count; i++) {
    const t = last > 0 ? i / last : 0;
    const sag = 4 * bow * t * (1 - t);
    let y = ay + dy * t + ny * sag;
    if (i > 0 && i < last && y < floorY) y = floorY;
    out[2 * (first + i)] = ax + dx * t + nx * sag;
    out[2 * (first + i) + 1] = y;
  }
  if (count > 0) {
    out[2 * first] = ax;
    out[2 * first + 1] = ay;
    out[2 * (first + last)] = bx;
    out[2 * (first + last) + 1] = by;
  }
  return sign;
}

/** Slack below this is drawn straight (m): a string "taut" to the eye still carries a millimetre or two. */
export const SLACK_DEADBAND = 0.004;
/** Time constants of the slack smoother, ms. Slack appears a little slower than it vanishes. */
const SLACK_RISE_MS = 50;
const SLACK_FALL_MS = 35;

/**
 * Smooths the drawn slack so a string hovering at the taut/slack boundary does not flicker between a
 * straight line and a bow: the bow grows like √slack, so a millimetre of noise can move it centimetres.
 * The deadband is subtracted (not thresholded) so the mapping stays continuous at zero.
 */
export class SlackSmoother {
  value = 0;

  /** `slack` is the measured L − chord (m), 0 when the physics says the string is taut. */
  step(slack: number, dtMs: number): number {
    const target = Number.isFinite(slack) ? Math.max(0, slack - SLACK_DEADBAND) : 0;
    const tau = target > this.value ? SLACK_RISE_MS : SLACK_FALL_MS;
    const alpha = Number.isFinite(dtMs) && dtMs > 0 ? 1 - Math.exp(-dtMs / tau) : 0;
    this.value += (target - this.value) * alpha;
    // Settle exactly at zero instead of decaying forever: lets the renderer skip the curve.
    if (this.value < 1e-6 && target === 0) this.value = 0;
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

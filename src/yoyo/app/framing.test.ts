import { describe, expect, it } from 'vitest';
import type { HandDetection, HandFrame, Landmark } from '../../shared/contracts';
import { createConfig } from '../config';
import { mappingFromHome, toWorld } from '../perception/worldMapping';
import { zoneCentre } from './TetherDetector';
import { FRAMING_TIMEOUT_MS, ZONE_HALF_SIZE, framingZone, guideForZone, measureHand } from './framing';

const IMAGE_ASPECT = 4 / 3;

describe('framingZone', () => {
  it('stands centred horizontally at 0.40 ih with half-size 0.22 × 0.14 ih', () => {
    const z = framingZone('standing');
    expect(zoneCentre(z)[0]).toBeCloseTo(2 / 3, 12);
    expect(zoneCentre(z)[1]).toBeCloseTo(0.4, 12);
    expect((z.x1 - z.x0) / 2).toBeCloseTo(0.22, 12);
    expect((z.y1 - z.y0) / 2).toBeCloseTo(0.14, 12);
    expect(ZONE_HALF_SIZE).toEqual([0.22, 0.14]);
  });

  it('puts the seated zone lower, same size and same horizontal centre', () => {
    const stand = framingZone('standing');
    const seat = framingZone('seated');
    expect(zoneCentre(seat)[1]).toBeCloseTo(0.6, 12);
    expect(zoneCentre(seat)[1]).toBeGreaterThan(zoneCentre(stand)[1]);
    expect(zoneCentre(seat)[0]).toBeCloseTo(zoneCentre(stand)[0], 12);
    expect(seat.x1 - seat.x0).toBeCloseTo(stand.x1 - stand.x0, 12);
    expect(seat.y1 - seat.y0).toBeCloseTo(stand.y1 - stand.y0, 12);
  });

  it.each(['standing', 'seated'] as const)('keeps the %s zone well inside the frame, clear of the edge margin', (preset) => {
    const z = framingZone(preset);
    const margin = createConfig(preset).perception.edgeMargin;
    expect(z.x0).toBeGreaterThan(margin);
    expect(z.x1).toBeLessThan(IMAGE_ASPECT - margin);
    expect(z.y0).toBeGreaterThan(margin);
    // The stroke of a throw needs room below the zone.
    expect(1 - z.y1).toBeGreaterThan(0.25);
  });

  it('is a proper rectangle (corners in order)', () => {
    for (const preset of ['standing', 'seated'] as const) {
      const z = framingZone(preset);
      expect(z.x1).toBeGreaterThan(z.x0);
      expect(z.y1).toBeGreaterThan(z.y0);
    }
  });
});

describe('guideForZone', () => {
  it('centres the outline on the world home, whatever the preset', () => {
    for (const preset of ['standing', 'seated'] as const) {
      const config = createConfig(preset);
      const guide = guideForZone(config, framingZone(preset));
      expect(guide.center[0]).toBeCloseTo(config.world.homeX, 12);
      expect(guide.center[1]).toBeCloseTo(config.world.homeY, 12);
    }
  });

  it('scales the half-size by the world scale', () => {
    const standing = createConfig('standing');
    const seated = createConfig('seated');
    const a = guideForZone(standing, framingZone('standing'));
    const b = guideForZone(seated, framingZone('seated'));
    expect(a.halfSize[0]).toBeCloseTo(0.22 * standing.world.scale, 12);
    expect(a.halfSize[1]).toBeCloseTo(0.14 * standing.world.scale, 12);
    // Larger gain: the same zone covers more world.
    expect(b.halfSize[0]).toBeCloseTo(0.22 / 0.7, 9);
    expect(b.halfSize[0]).toBeGreaterThan(a.halfSize[0]);
  });

  it('draws exactly what the runtime maps: the zone corners land on the outline corners', () => {
    const config = createConfig('standing');
    const zone = framingZone('standing');
    const guide = guideForZone(config, zone);
    const mapping = mappingFromHome(config, zoneCentre(zone));
    const topLeft = toWorld(mapping, zone.x0, zone.y0);
    const bottomRight = toWorld(mapping, zone.x1, zone.y1);
    expect(topLeft[0]).toBeCloseTo(guide.center[0] - guide.halfSize[0], 12);
    expect(topLeft[1]).toBeCloseTo(guide.center[1] + guide.halfSize[1], 12);
    expect(bottomRight[0]).toBeCloseTo(guide.center[0] + guide.halfSize[0], 12);
    expect(bottomRight[1]).toBeCloseTo(guide.center[1] - guide.halfSize[1], 12);
  });

  it('follows a live edit of the world scale', () => {
    const config = createConfig('standing');
    config.world.scale = 1.5;
    const guide = guideForZone(config, framingZone('standing'));
    expect(guide.halfSize[0]).toBeCloseTo(0.33, 12);
  });
});

/** A hand with the wrist at (wx, wy) and the four knuckles `palm` above it, in normalized image coordinates. */
function hand(wx: number, wy: number, palm: number, z = 0): HandDetection {
  const landmarks: Landmark[] = Array.from({ length: 21 }, () => ({ x: wx, y: wy, z: 0 }));
  for (const i of [5, 9, 13, 17]) landmarks[i] = { x: wx, y: wy - palm, z };
  return { landmarks, handedness: 'Right' };
}

const frame = (hands: readonly HandDetection[]): HandFrame => ({ timestampMs: 0, source: 'camera', hands });

describe('measureHand', () => {
  it('measures palm size in image heights, with the width scaled by the 4:3 aspect', () => {
    const m = measureHand(frame([hand(0.5, 0.8, 0.17)]));
    expect(m).not.toBeNull();
    expect(m!.palmSize).toBeCloseTo(0.17, 12);
    expect(m!.anchorY).toBeCloseTo(0.8 - 0.17, 12);
  });

  it('counts a sideways palm in image heights too (x is normalized to the width)', () => {
    const lm = hand(0.5, 0.5, 0).landmarks.map(p => ({ ...p }));
    for (const i of [5, 9, 13, 17]) lm[i] = { x: 0.5 + 0.1, y: 0.5, z: 0 };
    const m = measureHand(frame([{ landmarks: lm, handedness: 'Left' }]));
    expect(m!.palmSize).toBeCloseTo(0.1 * IMAGE_ASPECT, 12);
  });

  it('includes depth, like the extractor', () => {
    const flat = measureHand(frame([hand(0.5, 0.8, 0.12, 0)]))!;
    const tilted = measureHand(frame([hand(0.5, 0.8, 0.12, 0.09)]))!;
    expect(tilted.palmSize).toBeGreaterThan(flat.palmSize);
    expect(tilted.palmSize).toBeCloseTo(Math.hypot(0.12, 0.09 * IMAGE_ASPECT), 12);
  });

  it('takes the biggest hand when there are two', () => {
    const m = measureHand(frame([hand(0.2, 0.9, 0.08), hand(0.7, 0.8, 0.2)]));
    expect(m!.palmSize).toBeCloseTo(0.2, 12);
    expect(m!.anchorY).toBeCloseTo(0.6, 12);
  });

  it('is null without hands or with an incomplete hand', () => {
    expect(measureHand(frame([]))).toBeNull();
    expect(measureHand(frame([{ landmarks: [{ x: 0, y: 0, z: 0 }], handedness: 'Left' }]))).toBeNull();
  });

  it('skips a hand with non-finite landmarks', () => {
    const bad = hand(0.5, 0.8, 0.17);
    (bad.landmarks as Landmark[])[9] = { x: Number.NaN, y: 0.5, z: 0 };
    expect(measureHand(frame([bad]))).toBeNull();
  });
});

describe('FRAMING_TIMEOUT_MS', () => {
  it('is the ten seconds of the PRD', () => {
    expect(FRAMING_TIMEOUT_MS).toBe(10_000);
  });
});

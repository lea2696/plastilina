import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../contracts';
import {
  ANCHOR_LANDMARK, BONE_COUNT, HAND_LANDMARKS, HAND_TEMPLATE_UV, MAX_BONES, RING_TUBE_RATIO,
  buildHandPose, createHandPose, isDrawableHand, templateHand,
} from './handGeometry';

const PALM = 0.17;

describe('templateHand', () => {
  it('has 21 landmarks and puts landmark 9 exactly on the requested point', () => {
    for (const [tilt, curl] of [[0, 0], [0.4, 0], [-0.7, 0.5], [0.2, 1]] as const) {
      const hand = templateHand(0.12, 0.85, PALM, tilt, curl);
      expect(hand).toHaveLength(HAND_LANDMARKS);
      expect(hand[ANCHOR_LANDMARK][0]).toBeCloseTo(0.12, 12);
      expect(hand[ANCHOR_LANDMARK][1]).toBeCloseTo(0.85, 12);
    }
  });

  it('measures the requested wrist→knuckle distance', () => {
    const hand = templateHand(0, 0.85, PALM);
    expect(Math.hypot(hand[9][0] - hand[0][0], hand[9][1] - hand[0][1])).toBeCloseTo(PALM, 12);
    const bigger = templateHand(0, 0.85, 0.25, 0.3);
    expect(Math.hypot(bigger[9][0] - bigger[0][0], bigger[9][1] - bigger[0][1])).toBeCloseTo(0.25, 12);
  });

  it('puts the wrist below the knuckles and the fingertips above them (world y up)', () => {
    const hand = templateHand(0, 0.85, PALM);
    expect(hand[0][1]).toBeLessThan(hand[9][1]);
    for (const tip of [8, 12, 16, 20]) expect(hand[tip][1]).toBeGreaterThan(hand[9][1] - 0.001);
    expect(hand[12][1]).toBeGreaterThan(hand[8][1] - 0.05);
  });

  it('tilt rotates the fingers toward +x and curl pulls the fingertips toward the knuckles', () => {
    const straight = templateHand(0, 0.85, PALM);
    const tilted = templateHand(0, 0.85, PALM, 0.5);
    expect(tilted[12][0]).toBeGreaterThan(straight[12][0] + 0.03);
    const fist = templateHand(0, 0.85, PALM, 0, 1);
    for (const [knuckle, tip] of [[5, 8], [9, 12], [13, 16], [17, 20]] as const) {
      const open = Math.hypot(straight[tip][0] - straight[knuckle][0], straight[tip][1] - straight[knuckle][1]);
      const closed = Math.hypot(fist[tip][0] - fist[knuckle][0], fist[tip][1] - fist[knuckle][1]);
      expect(closed).toBeLessThan(open * 0.4);
    }
    // Knuckles and wrist do not move when the fingers curl.
    for (const i of [0, 1, 5, 9, 13, 17]) {
      expect(fist[i][0]).toBeCloseTo(straight[i][0], 12);
      expect(fist[i][1]).toBeCloseTo(straight[i][1], 12);
    }
  });

  it('matches the template proportions', () => {
    expect(HAND_TEMPLATE_UV).toHaveLength(HAND_LANDMARKS);
  });
});

describe('isDrawableHand', () => {
  it('accepts 21 finite points and rejects anything else', () => {
    const good = templateHand(0, 0.85, PALM);
    expect(isDrawableHand(good)).toBe(true);
    expect(isDrawableHand(null)).toBe(false);
    expect(isDrawableHand(good.slice(0, 20))).toBe(false);
    const nan = good.map((p): Vec2 => [p[0], p[1]]);
    nan[7] = [Number.NaN, 0.5];
    expect(isDrawableHand(nan)).toBe(false);
    const inf = good.map((p): Vec2 => [p[0], p[1]]);
    inf[20] = [0.1, Number.POSITIVE_INFINITY];
    expect(isDrawableHand(inf)).toBe(false);
  });
});

describe('buildHandPose', () => {
  it('translates the whole hand so landmark 9 sits exactly on the pivot', () => {
    const tracked = templateHand(0.2, 0.9, PALM, 0.1);
    const pose = createHandPose();
    // The smoothed pivot lags the tracked knuckle by a few centimetres.
    expect(buildHandPose(pose, tracked, 0.17, 0.86, true, PALM)).toBe(true);
    expect(pose.points[2 * ANCHOR_LANDMARK]).toBeCloseTo(0.17, 6);
    expect(pose.points[2 * ANCHOR_LANDMARK + 1]).toBeCloseTo(0.86, 6);
    // Every other landmark moved by the same offset: the silhouette keeps its shape.
    for (let i = 0; i < HAND_LANDMARKS; i++) {
      expect(pose.points[2 * i] - tracked[i][0]).toBeCloseTo(0.17 - 0.2, 6);
      expect(pose.points[2 * i + 1] - tracked[i][1]).toBeCloseTo(0.86 - 0.9, 6);
    }
  });

  it('does not translate when told not to (before the yoyo is tied on)', () => {
    const tracked = templateHand(0.2, 0.9, PALM);
    const pose = createHandPose();
    buildHandPose(pose, tracked, 0, 0.85, false, PALM);
    for (let i = 0; i < HAND_LANDMARKS; i++) {
      expect(pose.points[2 * i]).toBeCloseTo(tracked[i][0], 6);
      expect(pose.points[2 * i + 1]).toBeCloseTo(tracked[i][1], 6);
    }
  });

  it('describes every capsule with finite numbers and stays within the shader loop bound', () => {
    expect(BONE_COUNT).toBeLessThanOrEqual(MAX_BONES);
    const pose = createHandPose();
    buildHandPose(pose, templateHand(0, 0.85, PALM), 0, 0.85, true, PALM);
    expect(pose.count).toBe(BONE_COUNT);
    for (let i = 0; i < pose.count; i++) {
      for (let j = 0; j < 4; j++) expect(Number.isFinite(pose.seg[4 * i + j])).toBe(true);
      expect(pose.rad[2 * i]).toBeGreaterThan(0.004);
      expect(pose.rad[2 * i + 1]).toBeGreaterThan(0.004);
    }
    expect(Array.from(pose.arm).every(Number.isFinite)).toBe(true);
    expect(pose.smooth).toBeGreaterThan(0);
  });

  it('the bounding box contains every landmark and the forearm stub', () => {
    const pose = createHandPose();
    buildHandPose(pose, templateHand(0.1, 0.85, PALM, 0.3), 0.1, 0.85, true, PALM);
    for (let i = 0; i < HAND_LANDMARKS; i++) {
      expect(pose.points[2 * i]).toBeGreaterThan(pose.minX);
      expect(pose.points[2 * i]).toBeLessThan(pose.maxX);
      expect(pose.points[2 * i + 1]).toBeGreaterThan(pose.minY);
      expect(pose.points[2 * i + 1]).toBeLessThan(pose.maxY);
    }
    expect(pose.arm[3]).toBeGreaterThan(pose.minY);
    expect(pose.arm[3]).toBeLessThan(pose.points[1]); // the stub points below the wrist
  });

  it('thickness comes from palmWorld: radii scale with it', () => {
    const hand = templateHand(0, 0.85, PALM);
    const small = createHandPose();
    const big = createHandPose();
    buildHandPose(small, hand, 0, 0.85, true, 0.1);
    buildHandPose(big, hand, 0, 0.85, true, 0.2);
    for (let i = 0; i < small.count; i++) {
      expect(big.rad[2 * i] / small.rad[2 * i]).toBeCloseTo(2, 5);
    }
    expect(big.unit).toBeCloseTo(0.2, 12);
  });

  it('palmWorld = 0 (unknown) falls back to the measured wrist→knuckle distance', () => {
    const hand = templateHand(0, 0.85, 0.21);
    const pose = createHandPose();
    buildHandPose(pose, hand, 0, 0.85, true, 0);
    expect(pose.unit).toBeCloseTo(0.21, 5);
    buildHandPose(pose, hand, 0, 0.85, true, Number.NaN);
    expect(pose.unit).toBeCloseTo(0.21, 5);
  });

  it('is finite for a collapsed hand (all landmarks on one point)', () => {
    const collapsed: Vec2[] = Array.from({ length: HAND_LANDMARKS }, () => [0.3, 0.6] as Vec2);
    const pose = createHandPose();
    expect(buildHandPose(pose, collapsed, 0.3, 0.6, true, 0)).toBe(true);
    expect(pose.unit).toBeGreaterThan(0.02);
    for (let i = 0; i < 4 * pose.count; i++) expect(Number.isFinite(pose.seg[i])).toBe(true);
    expect(Number.isFinite(pose.ringX + pose.ringY + pose.ringDirX + pose.ringDirY + pose.ringRadius)).toBe(true);
    expect(Number.isFinite(pose.minX + pose.maxX + pose.minY + pose.maxY)).toBe(true);
  });

  it('refuses undrawable landmarks and leaves the previous pose untouched', () => {
    const pose = createHandPose();
    buildHandPose(pose, templateHand(0, 0.85, PALM), 0, 0.85, true, PALM);
    const before = Array.from(pose.seg);
    const bad = templateHand(0, 0.85, PALM).map((p): Vec2 => [p[0], p[1]]);
    bad[3] = [Number.NaN, 0];
    expect(buildHandPose(pose, bad, 0, 0.85, true, PALM)).toBe(false);
    expect(buildHandPose(pose, null, 0, 0.85, true, PALM)).toBe(false);
    expect(buildHandPose(pose, bad.slice(0, 10), 0, 0.85, true, PALM)).toBe(false);
    expect(Array.from(pose.seg)).toEqual(before);
  });

  it('ignores a non-finite anchor instead of poisoning every landmark', () => {
    const pose = createHandPose();
    const hand = templateHand(0.1, 0.85, PALM);
    buildHandPose(pose, hand, Number.NaN, Number.NaN, true, PALM);
    for (let i = 0; i < 2 * HAND_LANDMARKS; i++) expect(Number.isFinite(pose.points[i])).toBe(true);
    expect(pose.points[2 * ANCHOR_LANDMARK]).toBeCloseTo(0.1, 6);
  });

  describe('ring on the middle finger', () => {
    it('sits on the proximal phalanx, between landmarks 9 and 10', () => {
      const hand = templateHand(0.05, 0.85, PALM, 0.25);
      const pose = createHandPose();
      buildHandPose(pose, hand, 0.05, 0.85, true, PALM);
      const kx = pose.points[18];
      const ky = pose.points[19];
      const px = pose.points[20];
      const py = pose.points[21];
      const along = ((pose.ringX - kx) * (px - kx) + (pose.ringY - ky) * (py - ky)) / ((px - kx) ** 2 + (py - ky) ** 2);
      expect(along).toBeGreaterThan(0.2);
      expect(along).toBeLessThan(0.8);
      // On the bone's line, not beside it.
      const cross = (pose.ringX - kx) * (py - ky) - (pose.ringY - ky) * (px - kx);
      expect(Math.abs(cross)).toBeLessThan(1e-6);
      expect(Math.hypot(pose.ringDirX, pose.ringDirY)).toBeCloseTo(1, 6);
      expect(pose.ringDirX * (px - kx) + pose.ringDirY * (py - ky)).toBeGreaterThan(0);
    });

    it('is wide enough to clear the finger and scales with the hand', () => {
      const pose = createHandPose();
      buildHandPose(pose, templateHand(0, 0.85, PALM), 0, 0.85, true, PALM);
      // The inner edge of the ring (major radius minus tube radius) clears the middle finger's radius.
      const fingerRadius = pose.rad[2 * 7]; // capsule 7 = first of the middle finger: radius at the knuckle
      expect(pose.ringRadius * (1 - RING_TUBE_RATIO)).toBeGreaterThan(fingerRadius);
      const big = createHandPose();
      buildHandPose(big, templateHand(0, 0.85, 0.34), 0, 0.85, true, 0.34);
      expect(big.ringRadius / pose.ringRadius).toBeCloseTo(2, 5);
    });
  });
});

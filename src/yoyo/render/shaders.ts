import { MAX_BONES } from './handGeometry';

/**
 * GLSL for the yoyó renderer. Everything is generated here: no texture files, no fonts, no HDRI.
 *
 * Colour handling: the screen-space and overlay shaders (backdrop, hand, guide, spin ring) write
 * display-referred sRGB values straight to the canvas, with no tone mapping, because their colours are
 * chosen by eye as UI. Only the yoyo body and the string go through three's PBR pipeline.
 */

/** Signed-distance union of the hand's tapered capsules; shared by the hand and the guide's ghost hand. */
const HAND_SDF = /* glsl */ `
#define NB ${MAX_BONES}
uniform vec4 uSeg[NB];
uniform vec2 uRad[NB];
uniform int uCount;
uniform float uSmooth;

// Distance to a capsule whose radius varies linearly from r.x at a to r.y at b.
float yoSdSeg(vec2 p, vec4 s, vec2 r) {
  vec2 pa = p - s.xy;
  vec2 ba = s.zw - s.xy;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h) - mix(r.x, r.y, h);
}

// Polynomial smooth minimum: joins capsules without creases.
float yoSmin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / max(k, 1e-6);
  return min(a, b) - h * h * k * 0.25;
}

float yoHandSdf(vec2 p) {
  float d = 1e5;
  for (int i = 0; i < NB; i++) {
    if (i >= uCount) break;
    d = yoSmin(d, yoSdSeg(p, uSeg[i], uRad[i]), uSmooth);
  }
  return d;
}
`;

/** Full-screen backdrop in world units: floor line and gradient at y = 0 exactly where z = 0 projects. */
export const BACKDROP_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const BACKDROP_FRAGMENT = /* glsl */ `
uniform vec4 uRect;     // visible world rectangle at z = 0: left, right, bottom, top
uniform float uPx;      // world metres per pixel
uniform vec3 uWallTop;
uniform vec3 uWallBottom;
uniform vec3 uGlow;
uniform vec3 uFloorNear;
uniform vec3 uFloorFar;
uniform vec3 uLine;
varying vec2 vUv;

float yoHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 w = vec2(mix(uRect.x, uRect.y, vUv.x), mix(uRect.z, uRect.w, vUv.y));

  // Wall: a deep blue-grey that darkens toward the top, with one broad soft glow behind the play area.
  vec3 wall = mix(uWallBottom, uWallTop, smoothstep(0.0, 1.25, w.y));
  vec2 g = vec2(w.x * 0.85, (w.y - 0.5) * 0.7);
  wall += uGlow * exp(-dot(g, g) / 0.42);

  // Floor: below y = 0, a touch lighter at the line and falling off with distance from it.
  vec3 floorCol = mix(uFloorNear, uFloorFar, smoothstep(0.0, 0.45, -w.y));
  float onFloor = 1.0 - smoothstep(-uPx, uPx, w.y);
  vec3 col = mix(wall, floorCol, onFloor);

  // The floor line itself, and a faint haze just above it.
  float line = 1.0 - smoothstep(0.0, 1.5 * uPx, abs(w.y));
  col += uLine * line * 0.6;
  col += uLine * 0.045 * exp(-max(w.y, 0.0) / 0.05) * (1.0 - onFloor);

  // Vignette, then a hair of dither so the dark gradient does not band on 8-bit panels.
  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.55 * dot(c, c);
  col += (yoHash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

/** World-space quad vertex shader: passes the world xy of each fragment (z = 0 plane overlays). */
export const WORLD_QUAD_VERTEX = /* glsl */ `
varying vec2 vWorld;
varying vec2 vLocal;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xy;
  vLocal = position.xy;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/**
 * Translucent hand silhouette: the union of capsules as ONE shape (a faint fill, a brighter rim, a
 * crisp one-pixel outline), plus a forearm stub that fades out. Dimmed as a whole when the hand is lost.
 */
export const HAND_FRAGMENT = /* glsl */ `
${HAND_SDF}
uniform vec4 uArm;      // forearm a.xy, b.xy
uniform vec2 uArmRad;
uniform vec3 uTint;
uniform vec3 uBright;   // flash colour: a warm white
uniform vec3 uWarm;     // frame-edge warning colour: amber
uniform float uAlpha;   // presence: 1 while tracked, lower when the data is stale
uniform float uFlash;   // brief flash on tether / catch
uniform float uWarn;    // hand at the frame edge
uniform float uPx;
varying vec2 vWorld;

void main() {
  float dh = yoHandSdf(vWorld);
  float cover = 1.0 - smoothstep(-uPx, uPx, dh);
  float inside = max(-dh, 0.0);
  float rim = exp(-inside / 0.007);

  // Forearm: a capsule that fades out along its length so the hand does not look cut off at the wrist.
  vec2 ab = uArm.zw - uArm.xy;
  float along = clamp(dot(vWorld - uArm.xy, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
  float da = yoSdSeg(vWorld, uArm, uArmRad);
  float armCover = (1.0 - smoothstep(-uPx, uPx, da)) * (1.0 - smoothstep(0.0, 1.0, along));

  float fill = cover * (0.13 + 0.32 * rim);
  float outline = (1.0 - smoothstep(0.0, 1.4 * uPx, abs(dh))) * 0.38;
  float arm = armCover * 0.13;
  float alpha = max(max(fill, outline), arm);

  vec3 base = mix(uTint, uBright, clamp(uFlash * 0.8, 0.0, 1.0));
  base = mix(base, uWarm, clamp(uWarn * 0.9, 0.0, 1.0));
  // The flash and the warning also lift the fill, so they read even on a dim or cool hand.
  alpha = min(1.0, alpha * (1.0 + uFlash * 1.2 + uWarn * 1.1));
  alpha *= uAlpha;
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(base, alpha);
}
`;

/**
 * Framing guide: a soft dashed rounded outline plus a faint ghost hand inside it. The dash coordinate is
 * the arc length along one quarter of the contour (mirrored into the others), so dashes are even and the
 * pattern is symmetric. No animation of the dashes: motion is left to the (reduced-motion-aware) pulse.
 */
export const GUIDE_FRAGMENT = /* glsl */ `
${HAND_SDF}
uniform vec2 uCenter;
uniform vec2 uHalf;
uniform float uCorner;
uniform float uDashes;   // dashes per quarter of the outline
uniform vec3 uColor;
uniform float uAlpha;
uniform float uPx;
varying vec2 vWorld;

void main() {
  vec2 p = vWorld - uCenter;
  vec2 cc = uHalf - uCorner;
  vec2 q = abs(p) - cc;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uCorner;

  // Arc length along the contour of the (folded) quarter: top edge, corner arc, side edge.
  vec2 f = abs(p);
  float quarter = cc.x + 1.5707963 * uCorner + cc.y;
  float s;
  if (f.x > cc.x && f.y > cc.y) {
    s = cc.x + (1.5707963 - atan(f.y - cc.y, f.x - cc.x)) * uCorner;
  } else if (f.y > cc.y) {
    s = f.x;
  } else {
    s = cc.x + 1.5707963 * uCorner + (cc.y - f.y);
  }
  float period = quarter / uDashes;
  float dm = abs(s - period * floor(s / period + 0.5));
  float dash = 1.0 - smoothstep(0.28 * period - 0.003, 0.28 * period + 0.003, dm);

  float width = 0.0032;
  float line = 1.0 - smoothstep(width - uPx, width + uPx, abs(d));
  float glow = exp(-abs(d) / 0.014) * 0.22;
  float outline = line * dash + glow * (0.35 + 0.65 * dash);

  // Ghost hand: only a hint of where the hand goes.
  float dh = yoHandSdf(vWorld);
  float ghost = (1.0 - smoothstep(-uPx, uPx, dh)) * 0.07
    + (1.0 - smoothstep(0.0, 1.4 * uPx, abs(dh))) * 0.16;

  float alpha = clamp(outline * 0.85 + ghost, 0.0, 1.0) * uAlpha;
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

/**
 * Spin ring: a thin ring around the yoyo whose brightness grows with the spin. At low spin it carries
 * ticks that turn with the yoyo (so a slow spin is readable); the ticks blur into a plain ring as the spin
 * blurs, exactly like the face, so nothing ever aliases.
 */
export const SPIN_RING_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uBlur;     // 0 sharp .. 1 fully smeared
uniform float uAngle;    // spin angle, rad (reduced to one turn)
uniform float uRing;     // ring radius in quad units
uniform float uWidth;    // core half-width in quad units
varying vec2 vLocal;

void main() {
  vec2 p = vLocal * 2.0;
  float r = length(p);
  float core = exp(-pow((r - uRing) / uWidth, 2.0));
  float halo = exp(-pow((r - uRing) / (uWidth * 4.0), 2.0)) * 0.3;
  float ang = atan(p.y, p.x);
  float ticks = 0.5 + 0.5 * cos(24.0 * (ang - uAngle));
  float contrast = (1.0 - uBlur) * 0.7;
  float a = (core * (1.0 - contrast + contrast * ticks) + halo) * uAlpha;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

/**
 * Injected into MeshPhysicalMaterial: the machined face of the yoyo. Two finishes (anodised colour and
 * bare polished metal) in a three-bladed spiral, a polished hub cap and edge, a darker gap, and the
 * angular smear. The smear is the temporal average the camera would see: the blade pattern is sampled over
 * the angle the yoyo turns in one frame (ω/60) with Gaussian weights, and fades to its mean once that
 * window spans a pattern period, so it never strobes. On top, a concentric brushed streak (rotation
 * invariant, so it cannot alias either) grows with ω.
 */
export const FACE_VERTEX_DECLARATIONS = /* glsl */ `
varying vec3 vYoPos;
varying vec3 vYoNrm;
`;

export const FACE_VERTEX_BODY = /* glsl */ `
vYoPos = position;
vYoNrm = normal;
`;

export const FACE_FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec3 vYoPos;
varying vec3 vYoNrm;
uniform float uSpinAngle;
uniform float uSmear;
uniform float uStreak;
uniform vec3 uPolish;

// Polished share of the dish once the spin has averaged the blades away. The blades themselves cover
// about 29 % of the turn (sin > 0.62); a literal average would wash every colour out to pastel and a
// spinning yoyo would lose its identity, so the smeared face keeps only a silver sheen of that.
const float YO_BLADE_MEAN = 0.16;

float yoBlade(float ang, float rn) {
  // Three blades whose edges spiral outward, so the pattern reads as rotation and not as a static decal.
  return smoothstep(-0.12, 0.12, sin(3.0 * ang + 2.6 * rn) - 0.62);
}

float yoPattern(float ang, float rn) {
  float acc = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 9; i++) {
    float k = (float(i) - 4.0) / 4.0;
    float w = exp(-k * k * 2.0);
    acc += w * yoBlade(ang + k * uSmear * 0.5, rn);
    wsum += w;
  }
  // Once the window covers a pattern period the average is the mean; blend there instead of aliasing.
  float contrast = 1.0 - smoothstep(1.1, 2.3, uSmear);
  return mix(YO_BLADE_MEAN, acc / wsum, contrast);
}
`;

/** Replaces <metalnessmap_fragment>: runs after diffuseColor, roughnessFactor and metalnessFactor exist. */
export const FACE_FRAGMENT_BODY = /* glsl */ `
{
  float rn = length(vYoPos.xy);
  float phi = atan(vYoPos.y, vYoPos.x);
  float outerFace = step(0.5, abs(vYoPos.z));
  // 1 on the rim's side and fillets, 0 on faces that look along the axis.
  float edge = 1.0 - smoothstep(0.5, 0.78, abs(vYoNrm.z));

  vec3 anod = diffuseColor.rgb;
  float pat = yoPattern(phi - uSpinAngle, rn);

  float dish = outerFace * smoothstep(0.215, 0.24, rn) * (1.0 - smoothstep(0.76, 0.79, rn));
  float cap = outerFace * (1.0 - smoothstep(0.15, 0.175, rn));

  vec3 col = anod;
  float met = 0.9;
  float rough = 0.3;

  // Dish: blades of bare polished metal over the anodised colour.
  col = mix(col, mix(anod, uPolish, pat), dish);
  met = mix(met, mix(0.9, 1.0, pat), dish);
  rough = mix(rough, mix(0.34, 0.17, pat), dish);

  // Hub cap: polished steel.
  col = mix(col, uPolish, cap);
  met = mix(met, 1.0, cap);
  rough = mix(rough, 0.18, cap);

  // Machined edge: the rim's side is bare polished metal.
  col = mix(col, uPolish, edge * 0.9);
  met = mix(met, 1.0, edge);
  rough = mix(rough, 0.14, edge);

  // The string gap (faces that look at the mid-plane) is in shadow, darker toward the axle.
  float gap = (1.0 - outerFace) * (1.0 - edge);
  col *= mix(1.0, mix(0.22, 0.7, smoothstep(0.15, 0.95, rn)), gap);

  // Spin streak: smooth concentric bands, like the rings of light on a spun disc. Rotation invariant, so
  // they cannot alias with the frame rate; the bands fade out where they would be thinner than a pixel.
  float rings = 0.5 + 0.5 * sin(rn * 46.0 + 1.7 * sin(rn * 13.0));
  float resolvable = 1.0 - smoothstep(0.35, 0.8, fwidth(rn * 46.0));
  float band = (rings - 0.5) * resolvable;
  float brushed = uStreak * (1.0 - cap) * (1.0 - edge) * outerFace;
  col *= 1.0 + band * 0.5 * brushed;
  rough += band * 0.18 * brushed;
  col = mix(col, col * 1.06, uStreak * 0.4 * outerFace);

  diffuseColor.rgb = col;
  metalnessFactor = met;
  roughnessFactor = clamp(rough, 0.05, 1.0);
}
`;

/** Flat colour over the whole screen (the paused dimming): reuses BACKDROP_VERTEX. */
export const FLAT_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
void main() {
  if (uAlpha < 0.002) discard;
  gl_FragColor = vec4(uColor, uAlpha);
}
`;

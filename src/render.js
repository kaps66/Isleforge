// Isleforge renderer — satellite / topographic / biome / climate painting + overlays.
import { BIOME } from "./engine.js";

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function lerp(a, b, t) { return a + (b - a) * t; }
function mix3(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }

// smooth value noise for painterly patchiness (independent of sim noise)
function hhash(ix, iy) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hhash(ix, iy), b = hhash(ix + 1, iy), c = hhash(ix, iy + 1), d = hhash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

// satellite land palette by biome (base, dark variation, light variation)
const LAND = {
  3:  [[235, 220, 170], [214, 192, 138]],   // beach sand
  4:  [[74, 124, 89], [52, 96, 74]],        // mangrove
  5:  [[46, 110, 62], [28, 82, 48]],        // rainforest
  6:  [[168, 158, 92], [140, 128, 66]],     // savanna
  7:  [[224, 196, 132], [206, 172, 104]],   // desert
  8:  [[66, 118, 66], [44, 90, 52]],        // temp forest
  9:  [[122, 152, 84], [96, 126, 64]],      // grass
  10: [[52, 92, 72], [36, 70, 56]],         // taiga
  11: [[148, 156, 138], [120, 130, 114]],   // tundra
  12: [[122, 116, 108], [88, 84, 80]],      // rock
  13: [[240, 244, 248], [214, 224, 232]],   // snow
  14: [[64, 140, 180], [40, 110, 155]],     // lake
};

const BIOME_FLAT = [
  [16, 52, 102], [34, 96, 150], [86, 178, 190], [238, 224, 170], [70, 150, 100],
  [40, 130, 70], [200, 185, 100], [235, 205, 130], [70, 140, 80],
  [140, 175, 95], [60, 110, 90], [160, 170, 150], [130, 125, 118], [245, 248, 250], [70, 150, 195]
];

export function computeHillshade(elev, N, azimuthDeg = 315, altitudeDeg = 42, strength = 1) {
  const shade = new Float32Array(N * N);
  const az = azimuthDeg * Math.PI / 180, alt = altitudeDeg * Math.PI / 180;
  const sx = -Math.cos(az), sy = -Math.sin(az);
  const zc = Math.tan(alt) * 2.2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const xm = elev[y * N + Math.max(0, x - 1)], xp = elev[y * N + Math.min(N - 1, x + 1)];
      const ym = elev[Math.max(0, y - 1) * N + x], yp = elev[Math.min(N - 1, y + 1) * N + x];
      const dzdx = (xp - xm) * N * 0.055;
      const dzdy = (yp - ym) * N * 0.055;
      // lambert
      let v = (zc - dzdx * sx - dzdy * sy) / Math.sqrt(1 + dzdx * dzdx + dzdy * dzdy + zc * zc) ;
      v = clamp01((v - 0.35) / 0.55);
      shade[i] = lerp(1, 0.45 + 0.75 * v, strength);
    }
  }
  return shade;
}

export function paintBase(ctx, data, opts) {
  // opts: {style, hillshade, seaLevel, showReef, sunAz, sunAlt, hillStrength}
  const { N, elev, biomes, reef, moisture, temperature, lakeMask } = data;
  const slopeF = data.slope, filledF = data.filled, towns = data.settlements || [];
  const farmR = [5, 7.5, 11].map(v => v * N / 384);
  const sea = opts.seaLevel;
  const style = opts.style || "satellite";
  const img = ctx.createImageData(N, N);
  const d = img.data;
  const shade = (style === "satellite" || style === "topo") ? computeHillshade(elev, N, opts.sunAz ?? 315, opts.sunAlt ?? 42, opts.hillStrength ?? 0.85) : null;

  // precompute temp/moist ranges for climate view
  let tMin = 1e9, tMax = -1e9;
  if (style === "climate") {
    for (let i = 0; i < temperature.length; i++) { const t = temperature[i]; if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
    if (!(tMax > tMin)) { tMin = 0; tMax = 1; }
  }

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const e = elev[i];
      const o = i * 4;
      let r, g, b;
      const grain = hash2(x, y) ; // 0..1 deterministic texture

      if (style === "height") {
        const v = Math.round(e * 255);
        r = g = b = v;
        if (e <= sea) { r = 20; g = 60; b = 140; }
      } else if (style === "climate") {
        if (e <= sea) { r = 12; g = 38; b = 80; }
        else {
          const t = (temperature[i] - tMin) / (tMax - tMin);
          const m = moisture[i];
          // temp hue blue->red, moisture -> saturation/lightness feel: blend
          r = Math.round(lerp(70, 215, clamp01(t)) + (m - 0.5) * -30);
          g = Math.round(lerp(120, 120, t) + (m - 0.5) * 40);
          b = Math.round(lerp(200, 80, clamp01(t)) + (m - 0.5) * 30);
        }
      } else if (style === "biome") {
        const c = BIOME_FLAT[biomes[i]];
        const v = (grain - 0.5) * 14;
        r = c[0] + v; g = c[1] + v; b = c[2] + v;
        if (reef[i] && e <= sea) { r = 90; g = 220; b = 200; }
      } else if (style === "topo") {
        // hypsometric tint
        if (e <= sea) {
          const depth = (sea - e) / sea;
          let c = mix3([200, 235, 240], [150, 205, 225], clamp01(depth * 2));
          c = mix3(c, [30, 90, 150], clamp01(depth * 1.4));
          r = c[0]; g = c[1]; b = c[2];
        } else {
          const h = (e - sea) / (1 - sea);
          let c;
          if (lakeMask[i]) c = [110, 175, 210];
          else if (h < 0.12) c = mix3([228, 240, 200], [200, 225, 170], h / 0.12);
          else if (h < 0.35) c = mix3([200, 225, 170], [245, 225, 160], (h - 0.12) / 0.23);
          else if (h < 0.6) c = mix3([245, 225, 160], [200, 150, 115], (h - 0.35) / 0.25);
          else if (h < 0.82) c = mix3([200, 150, 115], [150, 130, 130], (h - 0.6) / 0.22);
          else c = mix3([150, 130, 130], [250, 250, 252], (h - 0.82) / 0.18);
          const v = (grain - 0.5) * 10;
          r = c[0] + v; g = c[1] + v; b = c[2] + v;
        }
        const sh = e <= sea ? 1 : shade[i];
        r *= sh; g *= sh; b *= sh;
      } else {
        // ---- satellite ----
        if (e <= sea) {
          const depth = clamp01((sea - e) / sea); // 0 shore -> 1 abyss
          // depth curve
          let c;
          if (depth < 0.08) c = mix3([127, 212, 196], [64, 170, 190], depth / 0.08);
          else if (depth < 0.3) c = mix3([64, 170, 190], [32, 110, 165], (depth - 0.08) / 0.22);
          else if (depth < 0.6) c = mix3([32, 110, 165], [16, 60, 115], (depth - 0.3) / 0.3);
          else c = mix3([16, 60, 115], [7, 30, 66], (depth - 0.6) / 0.4);
          // subtle swells
          const sw = (grain - 0.5) * 10 * (1 - depth * 0.6);
          r = c[0] + sw; g = c[1] + sw; b = c[2] + sw;
          // abyssal-hill undulation in deep water
          if (depth > 0.45) {
            const ab = 0.92 + 0.16 * vnoise(x * 0.03 + 9.1, y * 0.03 - 4.7);
            r *= ab; g *= ab; b *= ab;
          }
          // reef glow
          if (reef[i] && opts.showReef !== false) {
            const rw = reef[i] ? 1 : 0;
            r = lerp(r, 64, 0.55 * rw); g = lerp(g, 205, 0.55 * rw); b = lerp(b, 185, 0.55 * rw);
          }
          // shallow caustic shimmer
          if (depth < 0.12) {
            const ca = Math.sin((x * 0.35 + y * 0.21)) * Math.sin(x * 0.13 - y * 0.29);
            r += ca * 8; g += ca * 10; b += ca * 6;
          }
        } else {
          const h = (e - sea) / (1 - sea);
          const bb = biomes[i];
          if (bb === 14) {
            // ---- lakes: depth-graded water, muddy shallows, crisp shoreline ----
            const ld = clamp01((filledF[i] - e) / 0.008);
            let lc = mix3([132, 188, 210], [24, 88, 134], ld);
            const glint = vnoise(x * 0.33, y * 0.33) - 0.5;
            r = lc[0] + glint * 16; g = lc[1] + glint * 16; b = lc[2] + glint * 10;
            if (ld < 0.35) { // vegetated muddy margin
              const k = (0.35 - ld) / 0.35 * 0.5;
              r = lerp(r, 148, k); g = lerp(g, 138, k); b = lerp(b, 104, k);
            }
            const rim = (x > 0 && !lakeMask[i - 1]) || (x < N - 1 && !lakeMask[i + 1]) ||
                        (y > 0 && !lakeMask[i - N]) || (y < N - 1 && !lakeMask[i + N]);
            if (rim) { r *= 0.68; g *= 0.72; b *= 0.7; }
            const sh = shade[i];
            const s2 = lerp(1, sh, 0.45);
            r *= s2; g *= s2; b *= s2;
          } else {
          const pal = LAND[bb] || LAND[9];
          // moisture-driven blend + grain forest speckle
          const m = moisture[i];
          const t = clamp01(0.35 + (grain - 0.5) * 1.1 + (m - 0.5) * 0.55);
          let c = mix3(pal[1], pal[0], t);
          // broad vegetation patchiness (groves, meadows, clearings)
          if (bb === 5 || bb === 8 || bb === 9 || bb === 6 || bb === 10 || bb === 4) {
            const patch = vnoise(x * 0.045 + 7.3, y * 0.045 - 2.1);
            const pv = 0.88 + patch * 0.24;
            c = [c[0] * pv, c[1] * (0.9 + patch * 0.2), c[2] * (0.92 + patch * 0.12)];
          }
          // dense forest canopy speckle
          if (bb === 5 || bb === 8 || bb === 10 || bb === 4) {
            const sp = hash2(x * 3 + 7, y * 3 - 2);
            if (sp > 0.72) { c = mix3(c, [c[0] * 0.72, c[1] * 0.8, c[2] * 0.72], 0.6); }
            else if (sp < 0.2) { c = mix3(c, [c[0] * 1.12 + 8, c[1] * 1.12 + 8, c[2] * 1.05], 0.5); }
          }
          // dry crackle
          if (bb === 7 || bb === 6) {
            const cr = hash2(x * 5 - 11, y * 5 + 5);
            if (cr > 0.8) { c = mix3(c, [c[0] * 0.88, c[1] * 0.86, c[2] * 0.84], 0.5); }
          }
          // snow glint
          if (bb === 13) {
            const sg = hash2(x * 7 + 3, y * 7 + 9);
            if (sg > 0.86) { c = [c[0] + 16, c[1] + 16, c[2] + 12]; }
          }
          r = c[0]; g = c[1]; b = c[2];
          // coastal cliffs + high crags catch grey rock
          const sl = slopeF ? slopeF[i] : 0;
          if (sl > 1.7 && h < 0.3) {
            const k = clamp01((sl - 1.7) / 1.4) * 0.6;
            r = lerp(r, 108, k) * 0.94; g = lerp(g, 100, k) * 0.94; b = lerp(b, 92, k) * 0.94;
          } else if (sl > 2.6) {
            const k = clamp01((sl - 2.6) / 1.6) * 0.45;
            r = lerp(r, 120, k); g = lerp(g, 113, k); b = lerp(b, 105, k);
          }
          // faint high-altitude weathering (biome colors already carry the treeline)
          if (h > 0.85 && bb !== 13 && bb !== 3) {
            const k = clamp01((h - 0.85) / 0.15) * 0.3;
            r = lerp(r, 130, k); g = lerp(g, 124, k); b = lerp(b, 116, k);
          }
          // farmland patchwork around settlements
          if ((bb === 8 || bb === 9 || bb === 6 || bb === 5 || bb === 10) && towns.length) {
            for (let ti = 0; ti < towns.length; ti++) {
              const s = towns[ti];
              const dx = x - s.x, dy = y - s.y;
              const R = farmR[s.size] || farmR[0];
              const d2 = dx * dx + dy * dy;
              if (d2 < R * R) {
                const dd = Math.sqrt(d2);
                if (dd < 2.2) { // village dirt core
                  r = lerp(r, 176, 0.65); g = lerp(g, 154, 0.65); b = lerp(b, 108, 0.65);
                } else {
                  const blk = hhash((x >> 3) + ti * 131, y >> 3);
                  const wheat = blk > 0.45;
                  let fr = wheat ? 178 : 118, fg = wheat ? 158 : 148, fb2 = wheat ? 92 : 74;
                  if (((x + (y << 1)) & 7) < 2) { fr *= 0.86; fg *= 0.86; fb2 *= 0.86; } // furrows
                  const k = 0.62 * (1 - dd / R);
                  r = lerp(r, fr, k); g = lerp(g, fg, k); b = lerp(b, fb2, k);
                }
                break;
              }
            }
          }
          const sh = shade[i];
          r *= sh; g *= sh; b *= sh;
          // beach foam handled in overlay (crisper); here just wet sand band
          if (h < 0.012) { r = lerp(r, 242, 0.5); g = lerp(g, 230, 0.5); b = lerp(b, 196, 0.5); }
          }
        }
        // surf foam band (both styles read better with it baked)
        const dSea = Math.abs(e - sea);
        if (dSea < 0.0045) {
          const foamN = hash2(x * 2 + 31, y * 2 + 17);
          const w = (1 - dSea / 0.0045);
          const f = clamp01(w * 1.2 - foamN * 0.45) * 0.85;
          r = lerp(r, 245, f); g = lerp(g, 250, f); b = lerp(b, 248, f);
        }
      }
      d[o] = Math.max(0, Math.min(255, r));
      d[o + 1] = Math.max(0, Math.min(255, g));
      d[o + 2] = Math.max(0, Math.min(255, b));
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// contour overlay for topo style (and optional for satellite)
// Draws in raw canvas pixel space: pass the *display* ctx + display size.
export function drawContours(ctx2d, W, H, data, opts) {
  const { N, elev } = data;
  const sea = opts.seaLevel;
  const minor = opts.contourMinor ?? 75; // meters
  const major = opts.contourMajor ?? 375;
  const maxM = data.stats.maxElevM;
  const sx = W / N, sy = H / N;
  ctx2d.save();
  for (let y = 0; y < N - 1; y++) {
    for (let x = 0; x < N - 1; x++) {
      const i = y * N + x;
      const e = elev[i];
      if (e <= sea) continue;
      const hM = (e - sea) / (1 - sea) * maxM;
      const e2 = elev[i + 1], e3 = elev[i + N], e4 = elev[i + N + 1];
      if (e2 <= sea || e3 <= sea || e4 <= sea) continue;
      const hs = [(e2 - sea) / (1 - sea) * maxM, (e3 - sea) / (1 - sea) * maxM, (e4 - sea) / (1 - sea) * maxM];
      const lo = Math.min(hM, hs[0], hs[1], hs[2]), hi = Math.max(hM, hs[0], hs[1], hs[2]);
      if (Math.floor(hi / minor) !== Math.floor(lo / minor)) {
        const lvl = Math.floor(hi / minor) * minor;
        const isMajor = (lvl % major) < minor * 0.5;
        ctx2d.strokeStyle = isMajor ? "rgba(74,48,26,0.6)" : "rgba(96,74,50,0.30)";
        ctx2d.lineWidth = isMajor ? Math.max(1, sx * 0.42) : Math.max(0.6, sx * 0.22);
        const px = (x + 0.5) * sx, py = (y + 0.5) * sy;
        // tiny segment approximating contour direction (perp to gradient)
        const gx = (e2 - e), gy = (e3 - e);
        const len = Math.hypot(gx, gy) || 1;
        const nx = -gy / len, ny = gx / len;
        ctx2d.beginPath();
        ctx2d.moveTo(px - nx * sx * 0.6, py - ny * sy * 0.6);
        ctx2d.lineTo(px + nx * sx * 0.6, py + ny * sy * 0.6);
        ctx2d.stroke();
      }
    }
  }
  ctx2d.restore();
}

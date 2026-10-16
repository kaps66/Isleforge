// Isleforge engine — seeded noise, island shaping, erosion, hydrology, climate, biomes.
// No DOM here. Pure typed-array simulation. Works in page or worker.
export function hashSeed(str) {
  str = String(str ?? "isle");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // avalanche
  h += h << 13; h ^= h >>> 7;
  h += h << 3; h ^= h >>> 17;
  h += h << 5;
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- value / gradient noise ----
export function makeNoise(seed) {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  // gradient table for 2D (8 dirs)
  const gx = new Float32Array([1, -1, 1, -1, 1, -1, 0, 0]);
  const gy = new Float32Array([1, 1, -1, -1, 0, 0, 1, -1]);

  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function grad(h, x, y) {
    h &= 7;
    return gx[h] * x + gy[h] * y;
  }
  function noise2(x, y) {
    const X = Math.floor(x), Y = Math.floor(y);
    const xf = x - X, yf = y - Y;
    const xi = X & 255, yi = Y & 255;
    const aa = perm[(perm[xi] + yi) & 511];
    const ab = perm[(perm[xi] + yi + 1) & 511];
    const ba = perm[(perm[xi + 1] + yi) & 511];
    const bb = perm[(perm[xi + 1] + yi + 1) & 511];
    const u = fade(xf), v = fade(yf);
    const x1 = grad(aa, xf, yf) + (grad(ba, xf - 1, yf) - grad(aa, xf, yf)) * u;
    const x2 = grad(ab, xf, yf - 1) + (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1)) * u;
    return (x1 + (x2 - x1) * v) * 0.7071; // ~[-1,1]
  }
  function fbm(x, y, oct, lac = 2.02, gain = 0.5) {
    let amp = 0.5, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += amp * noise2(x * f, y * f);
      norm += amp;
      amp *= gain; f *= lac;
    }
    return sum / norm; // ~[-1,1]
  }
  function ridged(x, y, oct, lac = 2.1, gain = 0.5) {
    let amp = 0.5, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      const n = 1 - Math.abs(noise2(x * f, y * f));
      sum += amp * n * n;
      norm += amp;
      amp *= gain; f *= lac;
    }
    return sum / norm; // [0,1]-ish
  }
  return { noise2, fbm, ridged, rand };
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Minimal binary heap for priority flood
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (k[par] <= k[i]) break;
      [k[par], k[i]] = [k[i], k[par]];
      [v[par], v[i]] = [v[i], v[par]];
      i = par;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const topV = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return topV;
  }
}

// Biome ids
export const BIOME = {
  DEEP: 0, SLOPE: 1, SHALLOW: 2, BEACH: 3, MANGROVE: 4,
  RAINFOREST: 5, SAVANNA: 6, DESERT: 7, TEMPFOREST: 8,
  GRASS: 9, TAIGA: 10, TUNDRA: 11, ROCK: 12, SNOW: 13, LAKE: 14
};
export const BIOME_NAMES = [
  "Deep ocean", "Ocean slope", "Shallow shelf", "Beach", "Mangrove",
  "Rainforest", "Savanna", "Desert", "Temperate forest",
  "Grassland", "Taiga", "Tundra", "High rock", "Snow / ice", "Lake"
];

export function defaultParams() {
  return {
    seed: "isle-1",
    size: 384,            // grid N (256 / 384 / 512)
    islandSize: 0.52,     // 0.3..0.7 fraction of half-width
    seaLevel: 0.42,       // threshold on normalized elev
    complexity: 0.62,     // coastline wiggle 0..1
    mountains: 0.62,      // relief 0..1
    rainfall: 0.55,       // 0..1
    temperature: 0.62,    // 0..1 (cold..hot)
    erosion: 0.55,        // droplet amount 0..1
    warp: 0.55,           // domain warp 0..1
    windDeg: 45,          // prevailing wind FROM degrees
    archipelago: 0.25,    // 0..1 extra islets
    islandType: "continental", // continental|volcanic|atoll|archipelago|seamount
    worldKm: 26,          // full map width in km
    maxElevM: 0,          // 0 = auto from mountains
  };
}

function autoMaxElev(mountains, type) {
  let base = 350 + mountains * 2600;
  if (type === "volcanic") base = Math.max(base, 1400 + mountains * 1800);
  if (type === "atoll") base = Math.min(base, 220);
  if (type === "seamount") base *= 0.7;
  return base;
}

export async function generateIsland(userParams, onProgress) {
  const P = Object.assign(defaultParams(), userParams || {});
  const N = P.size | 0;
  const seedNum = hashSeed(P.seed);
  const nz = makeNoise(seedNum);
  const nz2 = makeNoise(seedNum ^ 0x9e3779b9);
  const nz3 = makeNoise(seedNum ^ 0x85ebca6b);
  const rng = mulberry32(seedNum ^ 0x1234567);

  const prog = async (f, msg) => { if (onProgress) onProgress(f, msg); await new Promise(r => setTimeout(r, 0)); };

  await prog(0.02, "Shaping landmass");
  const elev = new Float32Array(N * N);

  // island centres
  const centres = [{ x: 0.5 + (rng() - 0.5) * 0.06, y: 0.5 + (rng() - 0.5) * 0.06, r: 1 }];
  if (P.islandType === "archipelago" || P.archipelago > 0.02) {
    const extra = P.islandType === "archipelago" ? 4 + ((rng() * 3) | 0) : Math.round(P.archipelago * 5);
    for (let i = 0; i < extra; i++) {
      const a = rng() * Math.PI * 2;
      const d = 0.16 + rng() * 0.22;
      centres.push({
        x: centres[0].x + Math.cos(a) * d,
        y: centres[0].y + Math.sin(a) * d,
        r: 0.16 + rng() * 0.3 * (P.islandType === "archipelago" ? 1 : P.archipelago + 0.3)
      });
    }
  }
  if (P.islandType === "seamount") {
    centres.push({ x: 0.5 + (rng() - 0.5) * 0.4, y: 0.5 + (rng() - 0.5) * 0.4, r: 0.35 });
  }

  const freqBase = 2.6 + P.complexity * 3.2;
  const warpAmt = P.warp * 1.6;
  const mGain = 0.35 + P.mountains * 1.15;
  const ridgeMix = P.mountains * (P.islandType === "volcanic" ? 0.25 : 0.55);
  const islandR = 0.20 + P.islandSize * 0.30; // in uv units (half-width=0.5)

  // low-freq coast modulation field
  for (let y = 0; y < N; y++) {
    const v = y / (N - 1);
    for (let x = 0; x < N; x++) {
      const u = x / (N - 1);
      // domain warp
      const wx = nz.fbm(u * 3.1 + 11.3, v * 3.1 + 7.7, 4);
      const wz = nz.fbm(u * 3.1 - 4.2, v * 3.1 + 3.1, 4);
      const px = u * freqBase + wx * warpAmt * 1.4;
      const py = v * freqBase + wz * warpAmt * 1.4;
      const base = nz.fbm(px + seedNum % 13 * 0.13, py - seedNum % 7 * 0.11, 6);
      const ridge = nz.ridged(px * 1.15 + 5.2, py * 1.15 - 1.7, 5);
      let h = (base * 0.5 + 0.5) * (1 - ridgeMix) + ridge * ridgeMix;
      // detail
      h += 0.06 * nz2.noise2(u * 24, v * 24) * (0.4 + P.mountains * 0.6);
      // falloff: min over centres
      let land = -10;
      for (let c = 0; c < centres.length; c++) {
        const C = centres[c];
        const dx = (u - C.x), dy = (v - C.y) * 1.0;
        const d = Math.sqrt(dx * dx + dy * dy);
        const coastN = nz3.fbm(u * 3.4 + c * 9.1, v * 3.4 - c * 3.7, 4); // -1..1
        const coastN2 = nz3.noise2(u * 9.5 + c * 4.7, v * 9.5 - c * 8.3);
        const wobble = coastN * (0.05 + P.complexity * 0.11) + coastN2 * P.complexity * 0.035;
        const R = islandR * C.r;
        // 1 at centre -> 0 far. smooth crater rim for atoll handled later
        const t = (d + wobble) / (R * 1.55 + 1e-5);
        let f = 1 - smoothstep(0.05, 1.0, t);
        // steeper cone: broad coastal lowlands, concentrated high peaks
        f = Math.pow(Math.max(0, f), 1.7);
        if (f > land) land = f;
      }
      // combine: elevation signal minus ocean depth signal
      let e = h * (0.55 + 0.75 * mGain) * (0.30 + 0.70 * land) + land * (0.55 + 0.45 * mGain) - 0.52;
      // mountain-range mask so relief concentrates in ridges, not a flat plateau
      const rangeN = nz.ridged(u * 4.3 + 7.7, v * 4.3 - 2.9, 4) - 0.55;
      const rangeAmp = P.islandType === "atoll" ? 0.15 : 1;
      e += rangeN * (0.22 + P.mountains * 0.85) * land * rangeAmp;
      // island-type sculpting
      if (P.islandType === "volcanic") {
        const dx = u - centres[0].x, dy = v - centres[0].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const cone = Math.exp(-(d * d) / (2 * 0.028)) * 0.85;
        const crater = Math.exp(-(d * d) / (2 * 0.0016)) * 0.28;
        e += cone - crater;
      } else if (P.islandType === "atoll") {
        const dx = u - centres[0].x, dy = v - centres[0].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const ang = Math.atan2(dy, dx);
        // wobbly ring radius so atolls aren't perfect circles
        const wob = nz.fbm(Math.cos(ang) * 1.7 + 3.1, Math.sin(ang) * 1.7 - 1.2, 3);
        const ringR = islandR * 0.85 * (1 + wob * (0.22 + P.complexity * 0.30));
        const ring = Math.exp(-((d - ringR) * (d - ringR)) / (2 * 0.0018)) * 0.55;
        const lagoonDip = -0.22 * Math.exp(-(d * d) / (2 * 0.02));
        e = e * 0.25 + ring + lagoonDip + 0.02 * base;
      } else if (P.islandType === "seamount") {
        e *= 0.8;
        e -= 0.08;
      }
      elev[y * N + x] = e;
    }
    if ((y & 63) === 0) await prog(0.02 + 0.22 * (y / N), "Shaping landmass");
  }

  // normalize to 0..1 robustly (1st / 99th percentile)
  const sorted = Float32Array.from(elev);
  sorted.sort();
  const lo = sorted[(sorted.length * 0.02) | 0];
  const hi = sorted[(sorted.length * 0.985) | 0];
  const span = Math.max(1e-5, hi - lo);
  for (let i = 0; i < elev.length; i++) elev[i] = clamp01((elev[i] - lo) / span);

  // ---- hydraulic droplet erosion (land only-ish) ----
  const ero = P.erosion;
  if (ero > 0.01) {
    await prog(0.27, "Eroding highlands");
    const iters = Math.round(N * N * (0.03 + ero * 0.30) * 0.55);
    dropletErode(elev, N, {
      iterations: Math.min(90000, Math.max(4000, iters)),
      maxLifetime: 28,
      inertia: 0.06,
      sedimentCapacity: 3.2,
      minSlope: 0.02,
      erodeSpeed: 0.28 * (0.4 + ero),
      depositSpeed: 0.32,
      evaporateSpeed: 0.012,
      gravity: 3.2,
      radius: 2,
      seaLevel: P.seaLevel,
      rng
    }, async f => prog(0.27 + 0.20 * f, "Eroding highlands"));
    // light renormalize tails after erosion
    let mn = 1, mx = 0;
    for (let i = 0; i < elev.length; i++) { const v = elev[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const s = Math.max(1e-5, mx - mn);
    for (let i = 0; i < elev.length; i++) elev[i] = clamp01((elev[i] - mn) / s);
    // remap so sea level keeps similar land fraction: shift toward original sea percentile
    // (keep simple: blend 8% toward median to avoid all-land/all-sea after heavy erosion)
  }

  await prog(0.49, "Settling talus slopes");
  thermalErode(elev, N, 2 + Math.round(ero * 3), 0.5, P.seaLevel);

  // stamp a few closed lake basins on flat valley floors so inland
  // water survives even well-eroded terrain (done pre-fill so rivers drain into them)
  const bowlsMade = stampLakeBowls(elev, N, P.seaLevel, rng, P);

  // ---- depression fill (priority flood) ----
  await prog(0.55, "Filling basins");
  const filled = priorityFlood(elev, N, P.seaLevel);

  // ---- flow direction + accumulation ----
  await prog(0.62, "Tracing watersheds");
  const { acc, flowTo, slope } = flowAccumulation(filled, elev, N, P.seaLevel);

  // ---- lakes (adaptive: relax thresholds until real basins survive) ----
  const lakeMask = new Uint8Array(N * N);
  const lakeDepth = new Float32Array(N * N);
  for (let i = 0; i < elev.length; i++) {
    const hFrac0 = (elev[i] - P.seaLevel) / Math.max(1e-4, 1 - P.seaLevel);
    if (elev[i] > P.seaLevel + 0.004 && slope[i] < 1.1 && hFrac0 < 0.62) {
      lakeDepth[i] = filled[i] - elev[i];
    }
  }
  const lakeAttempts = [[0.0024, 26], [0.0016, 16], [0.0010, 10]];
  for (const [th, minB] of lakeAttempts) {
    lakeMask.fill(0);
    for (let i = 0; i < elev.length; i++) if (lakeDepth[i] > th) lakeMask[i] = 1;
    removeSmallBlobs(lakeMask, N, minB);
    let n = 0;
    for (let i = 0; i < lakeMask.length; i++) n += lakeMask[i];
    if (n >= 12) break;
    if (th === lakeAttempts[lakeAttempts.length - 1][0]) break;
  }

  // ---- rivers ----
  await prog(0.70, "Carving rivers");
  const rivers = traceRivers(filled, acc, N, P.seaLevel, lakeMask, {
    minAcc: Math.round(N * N / 900),
    maxRivers: 26
  });
  // carve river valleys slightly into elev for rendering realism
  for (const r of rivers) {
    for (let k = 0; k < r.cells.length; k += 1) {
      const idx = r.cells[k];
      elev[idx] = Math.max(0, elev[idx] - 0.0016 * Math.min(3, 0.6 + r.acc / 900));
    }
  }

  // ---- climate ----
  await prog(0.78, "Simulating climate");
  const maxElevM = P.maxElevM > 0 ? P.maxElevM : autoMaxElev(P.mountains, P.islandType);
  const temperature = new Float32Array(N * N);
  const moisture = new Float32Array(N * N);
  const windRad = (P.windDeg || 0) * Math.PI / 180; // direction wind blows TOWARD? treat as from->to vector
  const wvx = Math.cos(windRad), wvy = Math.sin(windRad);
  const baseT = -6 + P.temperature * 36; // sea-level mean °C: -6..30
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const e = elev[i];
      const hFrac = clamp01((e - P.seaLevel) / Math.max(1e-4, 1 - P.seaLevel));
      const hM = hFrac * maxElevM;
      const nT = nz2.fbm(x / N * 6 + 3, y / N * 6 - 8, 3) * 2.2;
      temperature[i] = baseT - hM * 0.0061 + nT;
    }
  }
  // moisture: base + orographic + coastal + noise, then blur
  const gradX = new Float32Array(N * N), gradZ = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const xm = elev[y * N + Math.max(0, x - 1)], xp = elev[y * N + Math.min(N - 1, x + 1)];
      const ym = elev[Math.max(0, y - 1) * N + x], yp = elev[Math.min(N - 1, y + 1) * N + x];
      gradX[i] = (xp - xm) * 0.5 * N / 60;
      gradZ[i] = (yp - ym) * 0.5 * N / 60;
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const e = elev[i];
      const oro = (gradX[i] * -wvx + gradZ[i] * -wvy); // >0 windward rising
      const nM = nz3.fbm(x / N * 5 - 2, y / N * 5 + 9, 4) * 0.5 + 0.5;
      let m = 0.18 + P.rainfall * 0.62 + oro * (0.35 + P.rainfall * 0.55) * 2.0 + nM * 0.28 - 0.14;
      // coastal humidity bonus
      const depth = e < P.seaLevel ? 0 : Math.min(1, (e - P.seaLevel) * 8);
      m += (1 - depth) * 0.10 * P.rainfall + 0.04;
      // high cold = drier (rain shadow-ish handled by oro too)
      moisture[i] = clamp01(m);
    }
  }
  boxBlur(moisture, N, 2);
  boxBlur(moisture, N, 2);

  // reef suitability noise
  const reefN = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    reefN[i] = nz2.fbm(x / N * 14 + 40, y / N * 14 - 21, 3) * 0.5 + 0.5;
  }

  // ---- biomes ----
  await prog(0.86, "Painting biomes");
  const biomes = new Uint8Array(N * N);
  const reef = new Uint8Array(N * N);
  const sea = P.seaLevel;
  let landCells = 0, peak = 0, peakIdx = 0;
  const biomeCount = new Array(15).fill(0);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const e = elev[i];
      if (e <= sea) {
        const depth = (sea - e) / Math.max(1e-4, sea);
        let b;
        if (depth > 0.55) b = BIOME.DEEP;
        else if (depth > 0.16) b = BIOME.SLOPE;
        else {
          b = BIOME.SHALLOW;
          // reef: warm, shallow, exposed-ish
          if (baseT > 19 && reefN[i] > 0.52 && depth < 0.13) reef[i] = 1;
        }
        biomes[i] = b; biomeCount[b]++;
        continue;
      }
      landCells++;
      if (e > peak) { peak = e; peakIdx = i; }
      if (lakeMask[i]) { biomes[i] = BIOME.LAKE; biomeCount[BIOME.LAKE]++; continue; }
      const hFrac = (e - sea) / (1 - sea);
      const T = temperature[i], M = moisture[i];
      const sl = slope[i];
      const hM = hFrac * maxElevM;
      let b;
      if (T < -6 || hM > maxElevM * 0.86 + 200) b = BIOME.SNOW;
      else if (hFrac < 0.035 && sl < 0.55) {
        // coast fringe
        if (T > 21 && M > 0.55) b = BIOME.MANGROVE;
        else b = BIOME.BEACH;
      }
      else if (hM > 1750 || (hFrac > 0.72 && sl < 2) || (sl > 2.6 && hM > 300)) {
        b = T < 1 ? BIOME.SNOW : BIOME.ROCK;
      }
      else if (T < 0.5) b = M > 0.45 ? BIOME.TUNDRA : BIOME.SNOW;
      else if (T < 3.5) b = M > 0.4 ? BIOME.TAIGA : BIOME.TUNDRA;
      else if (M < 0.20) b = T > 20 ? BIOME.DESERT : BIOME.GRASS;
      else if (M < 0.36) b = T > 19 ? BIOME.SAVANNA : BIOME.GRASS;
      else if (T > 21) b = M > 0.52 ? BIOME.RAINFOREST : BIOME.SAVANNA;
      else if (T > 10) b = M > 0.42 ? BIOME.TEMPFOREST : BIOME.GRASS;
      else b = M > 0.45 ? BIOME.TAIGA : BIOME.GRASS;
      // alpine overrides
      if (b !== BIOME.BEACH && b !== BIOME.MANGROVE) {
        if (hM > maxElevM * 0.82 && T < 6) b = M > 0.4 ? BIOME.TUNDRA : BIOME.ROCK;
        if (hM > maxElevM * 0.93) b = T < 2 ? BIOME.SNOW : BIOME.ROCK;
      }
      biomes[i] = b; biomeCount[b]++;
    }
  }

  // ---- settlements ----
  const settlements = placeSettlements(elev, slope, biomes, temperature, moisture, acc, N, sea, rng, maxElevM);

  const cellKm = P.worldKm / N;
  const cellArea = cellKm * cellKm;
  const areaKm2 = landCells * cellArea;
  const peakM = ((peak - sea) / Math.max(1e-4, 1 - sea)) * maxElevM;
  // coastline: land cells touching sea, with corner-count correction
  let coastCells = 0, lakeCells = 0, deepSum = 0, deepN = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    if (lakeMask[i]) lakeCells++;
    if (elev[i] <= sea) { deepSum += (sea - elev[i]) / sea; deepN++; continue; }
    let touch = false;
    for (let dy = -1; dy <= 1 && !touch; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      if (elev[ny * N + nx] <= sea) { touch = true; break; }
    }
    if (touch) coastCells++;
  }
  const maxDepthM = 400 + P.worldKm * 45;
  const stats = {
    landCells, areaKm2, peakM: Math.max(0, peakM),
    peakX: peakIdx % N, peakY: (peakIdx / N) | 0,
    riverCount: rivers.length,
    riverKm: rivers.reduce((s, r) => s + r.cells.length * cellKm, 0),
    coastKm: coastCells * cellKm * 0.9,
    lakeCells, lakeKm2: lakeCells * cellArea,
    maxDepthM, meanOceanDepth: deepN ? deepSum / deepN : 0,
    biomeCount, biomeFrac: biomeCount.map(c => c / (N * N)),
    landFrac: landCells / (N * N),
    meanTemp: avgAbove(temperature, elev, sea),
    meanMoist: avgAbove(moisture, elev, sea),
    maxElevM, cellKm
  };

  await prog(1, "Done");
  return { N, elev, filled, acc, slope, temperature, moisture, biomes, reef, lakeMask, rivers, settlements, stats, params: P, bowlsMade };
}

function avgAbove(field, elev, sea) {
  let s = 0, n = 0;
  for (let i = 0; i < field.length; i++) if (elev[i] > sea) { s += field[i]; n++; }
  return n ? s / n : 0;
}

function dropletErode(elev, N, o, onF) {
  const { iterations, maxLifetime, inertia, sedimentCapacity, minSlope, erodeSpeed, depositSpeed, evaporateSpeed, gravity, radius, seaLevel, rng } = o;
  const brushR = radius;
  // precompute brush weights
  const offsets = [];
  const weights = [];
  for (let dy = -brushR; dy <= brushR; dy++) for (let dx = -brushR; dx <= brushR; dx++) {
    const d2 = dx * dx + dy * dy;
    if (d2 <= brushR * brushR + 0.5) { offsets.push([dx, dy]); weights.push(Math.max(0, brushR - Math.sqrt(d2))); }
  }
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  const progEvery = Math.max(1, (iterations / 8) | 0);
  let done = 0;
  const doProg = onF ? (f) => onF(f) : null;

  for (let it = 0; it < iterations; it++) {
    let x = 2 + rng() * (N - 5);
    let y = 2 + rng() * (N - 5);
    let dx = 0, dy = 0, speed = 1, water = 1, sed = 0;
    for (let s = 0; s < maxLifetime; s++) {
      const xi = x | 0, yi = y | 0;
      if (xi < 1 || xi >= N - 2 || yi < 1 || yi >= N - 2) break;
      const xf = x - xi, yf = y - yi;
      const i00 = yi * N + xi;
      const h00 = elev[i00], h10 = elev[i00 + 1], h01 = elev[i00 + N], h11 = elev[i00 + N + 1];
      // gradient (bilinear)
      const gx = (h10 - h00) * (1 - yf) + (h11 - h01) * yf;
      const gy = (h01 - h00) * (1 - xf) + (h11 - h10) * xf;
      const h = h00 * (1 - xf) * (1 - yf) + h10 * xf * (1 - yf) + h01 * (1 - xf) * yf + h11 * xf * yf;
      dx = dx * inertia - gx * (1 - inertia);
      dy = dy * inertia - gy * (1 - inertia);
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      x += dx; y += dy;
      if (x < 1 || x >= N - 2 || y < 1 || y >= N - 2) break;
      // new height
      const nxi = x | 0, nyi = y | 0;
      const nxp = Math.min(1, Math.max(0, x - nxi)), nyp = Math.min(1, Math.max(0, y - nyi));
      const j00 = nyi * N + nxi;
      const nh = elev[j00] * (1 - nxp) * (1 - nyp) + elev[j00 + 1] * nxp * (1 - nyp) + elev[j00 + N] * (1 - nxp) * nyp + elev[j00 + N + 1] * nxp * nyp;
      const dh = nh - h;
      const cap = Math.max(-dh * speed * water * sedimentCapacity, minSlope * water * 0.15);
      // don't erode deep ocean much
      const oceanDamp = h < seaLevel ? 0.15 : 1;
      if (sed > cap || dh > 0) {
        let amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depositSpeed;
        sed -= amt;
        // deposit bilinear-ish at old cell
        elev[i00] += amt * (1 - xf) * (1 - yf) * oceanDamp;
        elev[i00 + 1] += amt * xf * (1 - yf) * oceanDamp;
        elev[i00 + N] += amt * (1 - xf) * yf * oceanDamp;
        elev[i00 + N + 1] += amt * xf * yf * oceanDamp;
      } else {
        let amt = Math.min((cap - sed) * erodeSpeed, -dh + 0.002) * oceanDamp;
        if (amt > 0) {
          // erode in brush around droplet
          for (let b = 0; b < offsets.length; b++) {
            const bx = xi + offsets[b][0], by = yi + offsets[b][1];
            if (bx < 1 || bx >= N - 1 || by < 1 || by >= N - 1) continue;
            const w = weights[b] / wSum;
            const delta = amt * w;
            elev[by * N + bx] -= delta;
          }
          sed += amt;
        }
      }
      speed = Math.sqrt(Math.max(0.01, speed * speed + (-dh) * gravity * 4));
      water *= (1 - evaporateSpeed);
      if (water < 0.01) break;
    }
    if (doProg && (it % progEvery === 0)) { done = it / iterations; /* fire and forget */ }
  }
  if (doProg) doProg(1);
}

function thermalErode(elev, N, iters, strength, seaLevel) {
  const talus = 0.055; // max height diff per cell before slide (in normalized units *?)
  const tmp = new Float32Array(N * N);
  for (let t = 0; t < iters; t++) {
    tmp.fill(0);
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        if (elev[i] < seaLevel - 0.05) continue;
        const h = elev[i];
        // find total excess over talus with 4 neighbors
        let tot = 0;
        const ns = [i - 1, i + 1, i - N, i + N];
        for (let k = 0; k < 4; k++) {
          const d = h - elev[ns[k]];
          if (d > talus) tot += d - talus;
        }
        if (tot > 0) {
          const move = Math.min(h * 0.5, tot * 0.25 * strength);
          tmp[i] -= move;
          for (let k = 0; k < 4; k++) {
            const d = h - elev[ns[k]];
            if (d > talus) tmp[ns[k]] += move * (d - talus) / tot;
          }
        }
      }
    }
    for (let i = 0; i < elev.length; i++) elev[i] += tmp[i];
  }
}

// Stamped lake basins with a sealed rim (maar / tarn style). The rim ring is
// forced above the pond floor so closure is guaranteed even on slopes;
// the wide blend keeps it reading as a natural moraine ridge.
function stampLakeBowls(elev, N, sea, rng, P) {
  if (P.islandType === "atoll") return 0;
  const want = P.rainfall < 0.25 ? 1 : P.rainfall < 0.6 ? 2 : 3;
  let made = 0;
  const picked = [];
  const lo = sea + 0.012, hi = sea + (1 - sea) * 0.6;
  const cand = [];
  for (let y = 8; y < N - 8 && cand.length < 3000; y += 4) {
    for (let x = 8; x < N - 8 && cand.length < 3000; x += 4) {
      const e = elev[y * N + x];
      if (e < lo || e > hi) continue;
      // keep clear of the surf so bowls don't breach into bays
      let ok = true;
      for (let dy = -3; dy <= 3 && ok; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (elev[(y + dy) * N + (x + dx)] < sea + 0.002) { ok = false; break; }
      }
      if (ok) cand.push([x, y, e]);
    }
  }
  for (let i = cand.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = cand[i]; cand[i] = cand[j]; cand[j] = t;
  }
  for (const [x, y, e0] of cand) {
    if (made >= want) break;
    const R = Math.max(3, N * (0.010 + rng() * 0.014));
    if (x - R * 2 < 2 || y - R * 2 < 2 || x + R * 2 >= N - 2 || y + R * 2 >= N - 2) continue;
    let clear = true;
    for (const p of picked) {
      const dx = p[0] - x, dy = p[1] - y;
      if (dx * dx + dy * dy < Math.pow(R + p[2], 2) * 6.25) { clear = false; break; }
    }
    if (!clear) continue;
    let D = 0.006 + rng() * 0.007;
    D = Math.min(D, e0 - (sea + 0.005));
    if (D < 0.003) continue;
    const rimT = e0 + D * 0.2;
    const W = Math.ceil(R * 2);
    for (let dy = -W; dy <= W; dy++) for (let dx = -W; dx <= W; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      const j = (y + dy) * N + (x + dx);
      if (d < R) {
        elev[j] -= D * (Math.cos(Math.PI * d / R) + 1) / 2;
      } else if (d < R * 2) {
        const bump = Math.sin(Math.PI * (d - R) / R);
        const k = bump * 0.9;
        const lifted = elev[j] + (rimT - elev[j]) * k;
        if (lifted > elev[j]) elev[j] = lifted;
      }
    }
    picked.push([x, y, R]);
    made++;
  }
  return made;
}

function priorityFlood(elev, N, seaLevel) {
  const filled = Float32Array.from(elev);
  const closed = new Uint8Array(N * N);
  const heap = new MinHeap();
  // push borders
  for (let x = 0; x < N; x++) {
    heap.push(elev[x], x);
    heap.push(elev[(N - 1) * N + x], (N - 1) * N + x);
    closed[x] = 2; closed[(N - 1) * N + x] = 2;
  }
  for (let y = 1; y < N - 1; y++) {
    heap.push(elev[y * N], y * N);
    heap.push(elev[y * N + N - 1], y * N + N - 1);
    closed[y * N] = 2; closed[y * N + N - 1] = 2;
  }
  const eps = 1e-3;
  while (heap.size) {
    const idx = heap.pop();
    if (closed[idx] === 1) continue;
    closed[idx] = 1;
    const cx = idx % N, cy = (idx / N) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const n = ny * N + nx;
      if (closed[n]) continue;
      closed[n] = 2;
      if (filled[n] < filled[idx] + eps * 0.02) {
        // only fill land depressions; never raise ocean
        if (filled[n] > seaLevel) filled[n] = filled[idx] + eps * 0.02;
      }
      heap.push(filled[n], n);
    }
  }
  return filled;
}

function flowAccumulation(filled, elev, N, sea) {
  const acc = new Float32Array(N * N);
  const flowTo = new Int32Array(N * N).fill(-1);
  const slope = new Float32Array(N * N);
  acc.fill(1);
  // order desc by filled
  const idx = new Array(N * N);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  idx.sort((a, b) => filled[b] - filled[a]);
  const dist = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const cx = i % N, cy = (i / N) | 0;
    let best = 0, bi = -1;
    const h = filled[i];
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const j = ny * N + nx;
      const drop = (h - filled[j]) / dist[n];
      if (drop > best) { best = drop; bi = j; }
      n++;
    }
    slope[i] = best * 60;
    if (bi >= 0) {
      flowTo[i] = bi;
      acc[bi] += acc[i];
    }
  }
  return { acc, flowTo, slope };
}

function traceRivers(filled, acc, N, sea, lakeMask, opts) {
  const minAcc = opts.minAcc || 200;
  const cands = [];
  for (let i = 0; i < acc.length; i++) {
    if (acc[i] >= minAcc && filled[i] > sea + 0.004 && !lakeMask[i]) cands.push(i);
  }
  cands.sort((a, b) => acc[b] - acc[a]);
  const claimed = new Uint8Array(N * N);
  const rivers = [];
  // recompute flowTo on filled for tracing
  const flowTo = new Int32Array(N * N).fill(-1);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    let best = 0, bi = -1;
    const h = filled[i];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const j = ny * N + nx;
      const d = (h - filled[j]) / ((dx && dy) ? Math.SQRT2 : 1);
      if (d > best) { best = d; bi = j; }
    }
    flowTo[i] = bi;
  }
  for (const s of cands) {
    if (rivers.length >= opts.maxRivers) break;
    if (claimed[s]) continue;
    // skip if too close to existing source
    const cells = [];
    let cur = s, guard = 0;
    const seen = new Set();
    while (cur >= 0 && guard++ < N * 3) {
      if (seen.has(cur)) break;
      seen.add(cur);
      cells.push(cur);
      claimed[cur] = 1;
      if (filled[cur] <= sea + 0.0008) break; // reached sea
      if (lakeMask[cur] && cells.length > 4) break;
      const nx = flowTo[cur];
      if (nx < 0) break;
      cur = nx;
    }
    if (cells.length < N * 0.03) {
      // too short — unclaim? keep claimed to avoid repeats
      continue;
    }
    rivers.push({ cells, acc: acc[s], mouth: cells[cells.length - 1], source: s });
  }
  // order longest first
  rivers.sort((a, b) => b.cells.length - a.cells.length);
  return rivers;
}

function removeSmallBlobs(mask, N, minSize) {
  const seen = new Uint8Array(N * N);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    // flood
    const stack = [i]; seen[i] = 1;
    const comp = [];
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      const x = c % N, y = (c / N) | 0;
      const nb = [];
      if (x > 0) nb.push(c - 1);
      if (x < N - 1) nb.push(c + 1);
      if (y > 0) nb.push(c - N);
      if (y < N - 1) nb.push(c + N);
      for (const n of nb) if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
    }
    if (comp.length < minSize) for (const c of comp) mask[c] = 0;
  }
}

function boxBlur(f, N, r) {
  const tmp = new Float32Array(f.length);
  // horizontal
  for (let y = 0; y < N; y++) {
    let run = 0;
    for (let x = -r; x < N + r; x++) {
      const xi = Math.min(N - 1, Math.max(0, x + r));
      const xo = Math.min(N - 1, Math.max(0, x - r - 1));
      if (x >= -r && x < N + r) { /* incremental */ }
      // simpler: direct window (N<=512 so fine)
    }
    for (let x = 0; x < N; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(N - 1, Math.max(0, x + k));
        s += f[y * N + xx]; n++;
      }
      tmp[y * N + x] = s / n;
    }
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(N - 1, Math.max(0, y + k));
        s += tmp[yy * N + x]; n++;
      }
      f[y * N + x] = s / n;
    }
  }
}

function placeSettlements(elev, slope, biomes, temp, moist, acc, N, sea, rng, maxElevM) {
  const score = new Float32Array(N * N);
  for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
    const i = y * N + x;
    if (elev[i] <= sea + 0.004) continue;
    const b = biomes[i];
    if (b === 14 || b === 13 || b === 0 || b === 1 || b === 2) continue;
    const hFrac = (elev[i] - sea) / (1 - sea);
    const hM = hFrac * maxElevM;
    if (hM > 900) continue;
    let s = 1;
    s -= Math.min(1, slope[i] * 0.9) * 0.8;         // flat preferred
    s -= Math.max(0, hFrac - 0.25) * 1.4;            // lowlands
    const T = temp[i], M = moist[i];
    if (T < 2 || T > 33) s -= 0.5;
    if (M < 0.15) s -= 0.45;                          // water needed
    if (b === 4 || b === 5 || b === 8 || b === 9) s += 0.25;
    if (b === 7 || b === 11 || b === 12) s -= 0.5;
    // near water bonus: check 9px neighborhood for sea/lake/river-acc
    let nearWater = 0;
    for (let dy = -6; dy <= 6; dy += 3) for (let dx = -6; dx <= 6; dx += 3) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const j = ny * N + nx;
      if (elev[j] <= sea || biomes[j] === 14 || acc[j] > 120) { nearWater = 1; break; }
    }
    if (nearWater) s += 0.35;
    // coastal port bonus
    let coast = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      if (elev[ny * N + nx] <= sea) { coast = 1; break; }
    }
    if (coast) s += 0.15;
    score[i] = s + rng() * 0.22;
  }
  // pick spaced maxima
  const order = [];
  for (let i = 0; i < score.length; i++) if (score[i] > 0.55) order.push(i);
  order.sort((a, b) => score[b] - score[a]);
  const out = [];
  const minDist = N * 0.09;
  for (const i of order) {
    if (out.length >= 7) break;
    const x = i % N, y = (i / N) | 0;
    let ok = true;
    for (const s of out) {
      const dx = s.x - x, dy = s.y - y;
      if (dx * dx + dy * dy < minDist * minDist * (s.port ? 0.5 : 1)) { ok = false; break; }
    }
    if (!ok) continue;
    // port if near coast
    let coast = false;
    for (let dy = -4; dy <= 4 && !coast; dy++) for (let dx = -4; dx <= 4 && !coast; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      if (elev[ny * N + nx] <= sea) coast = true;
    }
    out.push({ x, y, score: score[i], port: coast && out.filter(s => s.port).length < 2, size: 0 });
  }
  // largest = town
  out.sort((a, b) => b.score - a.score);
  out.forEach((s, k) => s.size = k === 0 ? 2 : (k < 3 ? 1 : 0));
  return out;
}

// ---- island name ----
const NA = ["Ka", "Mo", "Ta", "Na", "Sa", "Va", "Lo", "Re", "Sha", "Tho", "Ae", "Il", "O", "U", "Se", "Ma"];
const NB = ["ran", "loa", "nara", "thu", "mir", "dos", "lan", "ther", "kai", "vos", "mara", "sei", "lon", "dral", "pen"];
const NC = ["Isle", "Atoll", "Cay", "Holm", "Reef", "Shoal", "Rock", "Bay"];
export function islandName(seedStr) {
  const r = mulberry32(hashSeed("name:" + seedStr));
  const a = NA[(r() * NA.length) | 0], b = NB[(r() * NB.length) | 0];
  let n = a + b;
  if (r() < 0.3) n += NB[(r() * NB.length) | 0];
  return n + " " + NC[(r() * NC.length) | 0];
}

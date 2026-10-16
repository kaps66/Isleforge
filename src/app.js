// Isleforge app glue — controls, generation orchestration, overlays, stats, export.
import { generateIsland, islandName, hashSeed, BIOME_NAMES } from "./engine.js";
import { paintBase, drawContours } from "./render.js";

const $ = (id) => document.getElementById(id);
const els = {};
["seedInput","newBtn","diceBtn","sizeSel","typeSel","styleTabs","islandSize","seaLevel","complexity","mountains","rainfall","temperature","erosion","warp","windDeg","archipelago","worldKm","sunAz","hillStrength","showRivers","showLabels","showRoads","showContours","showGrid","showReef","regenBtn","surpriseBtn","dlBtn","linkBtn","mapCanvas","offCanvas","progressWrap","progressBar","progressMsg","statName","statSeed","statArea","statPeak","statRivers","statClimate","statCoast","statLakes","statHabit","biomeBars","legend","mapWrap","genNote"].forEach(id => els[id] = document.getElementById(id));

const off = els.offCanvas;
const octx = off.getContext("2d", { willReadFrequently: true });
const view = els.mapCanvas;
const vctx = view.getContext("2d");

let current = null;   // last generated data
let renderOpts = null;
let generating = false;

function randomSeed() {
  return String(100000 + ((Math.random() * 900000) | 0));
}

// Seeds are numeric-only. Legacy text seeds (old share links) fold to a number.
function cleanSeed(raw) {
  const digs = String(raw ?? "").replace(/\D/g, "").slice(0, 6);
  if (digs.length >= 3) return String(parseInt(digs, 10));
  const fallback = String(raw ?? "isle");
  return String(100000 + (hashSeed(fallback) % 900000));
}

function readParams() {
  const seed = cleanSeed(els.seedInput.value.trim() || randomSeed());
  return {
    seed,
    size: parseInt(els.sizeSel.value, 10),
    islandType: els.typeSel.value,
    islandSize: parseFloat(els.islandSize.value),
    seaLevel: parseFloat(els.seaLevel.value),
    complexity: parseFloat(els.complexity.value),
    mountains: parseFloat(els.mountains.value),
    rainfall: parseFloat(els.rainfall.value),
    temperature: parseFloat(els.temperature.value),
    erosion: parseFloat(els.erosion.value),
    warp: parseFloat(els.warp.value),
    windDeg: parseFloat(els.windDeg.value),
    archipelago: parseFloat(els.archipelago.value),
    worldKm: parseFloat(els.worldKm.value),
  };
}
function readView() {
  const style = document.querySelector(".tab.active")?.dataset.style || "satellite";
  return {
    style,
    sunAz: parseFloat(els.sunAz.value),
    sunAlt: 42,
    hillStrength: parseFloat(els.hillStrength.value),
    showRivers: els.showRivers.checked,
    showLabels: els.showLabels.checked,
    showRoads: els.showRoads.checked,
    showContours: els.showContours.checked || style === "topo",
    showGrid: els.showGrid.checked,
    showReef: els.showReef.checked,
  };
}

function syncLabels() {
  const pairs = [["islandSize","islandSizeV","%"],["seaLevel","seaLevelV",""],["complexity","complexityV",""],["mountains","mountainsV",""],["rainfall","rainfallV",""],["temperature","temperatureV","°"],["erosion","erosionV",""],["warp","warpV",""],["windDeg","windDegV","°"],["archipelago","archipelagoV",""],["worldKm","worldKmV"," km"],["sunAz","sunAzV","°"],["hillStrength","hillStrengthV",""]];
  for (const [a,b,suf] of pairs) {
    const el = els[a], lab = document.getElementById(b);
    if (!el || !lab) continue;
    let v = parseFloat(el.value);
    if (a === "temperature") v = Math.round(-6 + v * 36) + "°C";
    else if (a === "seaLevel") v = Math.round(v * 100);
    else if (a === "worldKm") v = v + " km";
    else if (a === "windDeg" || a === "sunAz") v = Math.round(v) + "°";
    else if (suf === "%") v = Math.round(v * 100) + "%";
    else v = v;
    lab.textContent = v;
  }
}

function setBusy(b, msg) {
  generating = b;
  els.progressWrap.hidden = !b;
  els.regenBtn.disabled = b; els.newBtn.disabled = b;
  if (msg) els.progressMsg.textContent = msg;
}

export async function regenerate(newSeed) {
  if (generating) return;
  if (newSeed) els.seedInput.value = newSeed;
  const params = readParams();
  els.seedInput.value = params.seed;
  setBusy(true, "Waking the ocean…");
  syncLabels();
  try {
    const data = await generateIsland(params, (f, msg) => {
      els.progressBar.style.width = Math.round(f * 100) + "%";
      els.progressMsg.textContent = msg + " — " + Math.round(f * 100) + "%";
    });
    current = data;
    renderOpts = readView();
    paint();
    updateStats();
    writeHash(params);
    els.genNote.textContent = `Seed ${params.seed} · ${data.N}×${data.N} grid · ${(data.stats.areaKm2).toFixed(1)} km² land`;
  } catch (err) {
    console.error(err);
    els.progressMsg.textContent = "Generation failed: " + (err?.message || err);
    await new Promise(r => setTimeout(r, 1800));
  } finally {
    setBusy(false);
  }
}

// repaint only (style / overlay toggles) — no resimulation
export function paint() {
  if (!current) return;
  const view0 = readView();
  renderOpts = view0;
  const { N } = current;
  off.width = N; off.height = N;
  paintBase(octx, current, {
    style: view0.style, seaLevel: current.params.seaLevel,
    sunAz: view0.sunAz, sunAlt: view0.sunAlt,
    hillStrength: view0.hillStrength, showReef: view0.showReef,
  });
  // display size: fit container, keep square, cap device pixels
  const box = els.mapWrap.clientWidth || 800;
  const css = Math.min(box, 860);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  view.style.width = css + "px"; view.style.height = css + "px";
  view.width = Math.round(css * dpr); view.height = Math.round(css * dpr);
  vctx.imageSmoothingEnabled = true;
  vctx.imageSmoothingQuality = "high";
  vctx.clearRect(0, 0, view.width, view.height);
  // rounded-clip ocean backdrop
  vctx.save();
  roundClip(vctx, 0, 0, view.width, view.height, 18 * dpr);
  vctx.drawImage(off, 0, 0, view.width, view.height);
  const S = view.width / N; // display px per cell
  if (view0.style === "topo" || view0.showContours) {
    drawContours(vctx, view.width, view.height, current, {
      seaLevel: current.params.seaLevel, contourMinor: 60, contourMajor: 300,
    });
  }
  if (view0.showRivers) drawRivers(vctx, current, S, view0.style);
  if (view0.showRoads) drawRoads(vctx, current, S, dpr, view0.style);
  drawSettlements(vctx, current, S, dpr, view0);
  if (view0.showLabels) drawPeakLabel(vctx, current, S, dpr);
  if (view0.showLabels && (view0.style === "satellite" || view0.style === "topo")) {
    drawRiverNames(vctx, current, S, dpr);
    drawSoundings(vctx, current, S, dpr);
  }
  if (view0.showGrid) drawGraticule(vctx, current, S, dpr);
  drawScale(vctx, current, dpr);
  drawCompass(vctx, current, dpr, view0);
  // vignette
  const g = vctx.createRadialGradient(view.width/2, view.height/2, view.width*0.35, view.width/2, view.height/2, view.width*0.78);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(4,10,24,0.34)");
  vctx.fillStyle = g;
  vctx.fillRect(0, 0, view.width, view.height);
  vctx.restore();
}

function roundClip(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
  c.clip();
}

function drawRivers(c, data, S, style) {
  const { N } = data;
  c.save();
  c.lineJoin = "round"; c.lineCap = "round";
  const rivers = data.rivers;
  for (let ri = rivers.length - 1; ri >= 0; ri--) {
    const r = rivers[ri];
    // taper: thin headwaters -> wider mouth
    const wCells = 0.35 + Math.min(1.9, Math.log10(1 + r.acc / 120) * 1.05);
    // smooth polyline (moving average) to hide grid steps
    const pts = [];
    const cells = r.cells;
    for (let k = 0; k < cells.length; k++) {
      const i0 = cells[Math.max(0, k - 1)], i1 = cells[k], i2 = cells[Math.min(cells.length - 1, k + 1)];
      const x = (((i0 % N) + (i1 % N) + (i2 % N)) / 3 + 0.5) * S;
      const y = ((((i0 / N) | 0) + ((i1 / N) | 0) + ((i2 / N) | 0)) / 3 + 0.5) * S;
      pts.push([x, y]);
    }
    const w = wCells * S;
    const drawPath = () => {
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) c.lineTo(pts[k][0], pts[k][1]);
    };
    // casing then water
    drawPath();
    c.strokeStyle = style === "biome" ? "rgba(20,60,90,0.8)" : "rgba(24,58,76,0.6)";
    c.lineWidth = Math.max(S * 0.8, w * 1.15 + S * 0.3);
    c.stroke();
    drawPath();
    c.strokeStyle = style === "topo" ? "rgba(80,160,210,0.95)" : "rgba(126,196,228,0.92)";
    c.lineWidth = Math.max(S * 0.5, w * 0.72);
    c.stroke();
  }
  // lakes shimmer outline
  c.restore();
}

const TOWN_NAMES = ["Port", "Bay", "Haven", "Landing", "Harbor", "Rest", "Village", "Town"];

// Dirt roads: minimum-spanning chain over settlements, curved beziers,
// drawn only across dry land so they never cross water.
function drawRoads(c, data, S, dpr, style) {
  const { N, elev, lakeMask } = data;
  const sea = data.params.seaLevel;
  const towns = data.settlements;
  if (towns.length < 2) return;
  const linked = [towns[0]];
  const rest = towns.slice(1);
  const pairs = [];
  while (rest.length) {
    let bi = 0, bj = 0, bd = 1e18;
    for (let i = 0; i < rest.length; i++) for (let j = 0; j < linked.length; j++) {
      const dx = rest[i].x - linked[j].x, dy = rest[i].y - linked[j].y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
    pairs.push([linked[bj], rest[bi]]);
    linked.push(rest.splice(bi, 1)[0]);
  }
  const dry = (gx, gy) => {
    if (gx < 0 || gy < 0 || gx >= N || gy >= N) return false;
    const i = gy * N + gx;
    return elev[i] > sea + 0.002 && !lakeMask[i];
  };
  c.save();
  c.lineJoin = "round"; c.lineCap = "round";
  pairs.forEach(([a, b], pi) => {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const bend = ((hashSeed(data.params.seed + ":" + pi) % 100) / 100 - 0.5) * len * 0.45;
    const cx = mx - dy / len * bend, cy = my + dx / len * bend;
    const pts = [];
    for (let k = 0; k <= 44; k++) {
      const t = k / 44, u = 1 - t;
      pts.push([u * u * a.x + 2 * u * t * cx + t * t * b.x, u * u * a.y + 2 * u * t * cy + t * t * b.y]);
    }
    // split into dry runs so roads stop at shores and lakes
    let run = [];
    const flush = () => {
      if (run.length > 3) {
        for (const [lw, col, dash] of [[S * 0.85, "rgba(18,24,34,0.6)", null], [S * 0.42, style === "topo" ? "rgba(120,80,40,0.9)" : "rgba(216,188,138,0.9)", [S * 1.1, S * 0.8]]]) {
          c.beginPath();
          run.forEach(([px, py], k) => {
            const X = (px + 0.5) * S, Y = (py + 0.5) * S;
            if (k === 0) c.moveTo(X, Y); else c.lineTo(X, Y);
          });
          c.lineWidth = Math.max(0.8, lw);
          c.strokeStyle = col;
          c.setLineDash(dash || []);
          c.stroke();
        }
        c.setLineDash([]);
      }
      run = [];
    };
    for (const [px, py] of pts) {
      if (dry(Math.round(px), Math.round(py))) run.push([px, py]);
      else flush();
    }
    flush();
  });
  c.restore();
}

function riverName(seedStr, k) {
  return islandName(seedStr + ":river:" + k).split(" ")[0] + " River";
}

function drawRiverNames(c, data, S, dpr) {
  const { N } = data;
  c.save();
  c.textBaseline = "middle";
  const named = data.rivers.filter(r => r.cells.length > N * 0.045).slice(0, 3);
  named.forEach((r, k) => {
    const mid = r.cells[(r.cells.length * 0.45) | 0];
    const x = (mid % N + 0.5) * S, y = (((mid / N) | 0) + 0.5) * S;
    const label = riverName(data.params.seed, k);
    c.font = `italic ${10.5 * dpr}px Georgia, serif`;
    const w = c.measureText(label).width;
    c.fillStyle = "rgba(6,14,26,0.6)";
    c.fillRect(x - w / 2 - 4 * dpr, y - 8 * dpr, w + 8 * dpr, 16 * dpr);
    c.fillStyle = "#bfe3f5";
    c.textAlign = "center";
    c.fillText(label, x, y + 0.5 * dpr);
  });
  c.restore();
}

// Admiralty-style depth soundings at scattered deep points
function drawSoundings(c, data, S, dpr) {
  const { N, elev } = data;
  const sea = data.params.seaLevel;
  const spots = [];
  const minD = N * 0.22;
  for (let y = 4; y < N - 4; y += 3) for (let x = 4; x < N - 4; x += 3) {
    const i = y * N + x;
    if (elev[i] > sea - sea * 0.25) continue; // deep water only
    let ok = true;
    for (const s of spots) {
      const dx = s.x - x, dy = s.y - y;
      if (dx * dx + dy * dy < minD * minD) { ok = false; break; }
    }
    if (ok) {
      spots.push({ x, y, e: elev[i] });
      if (spots.length >= 5) break;
    }
    if (spots.length >= 5) break;
  }
  c.save();
  c.font = `italic ${9.5 * dpr}px ui-monospace, monospace`;
  c.textAlign = "center"; c.textBaseline = "middle";
  c.fillStyle = "rgba(170,205,235,0.8)";
  for (const s of spots) {
    const depthM = Math.round((sea - s.e) / sea * data.stats.maxDepthM / 10) * 10;
    c.fillText(String(depthM), (s.x + 0.5) * S, (s.y + 0.5) * S);
  }
  c.restore();
}
function townName(seedIdx, port) {
  const base = islandName("t" + seedIdx).split(" ")[0];
  if (port) return base + " " + TOWN_NAMES[(seedIdx * 7) % 5];
  return base + " " + TOWN_NAMES[5 + (seedIdx % 3)];
}

function drawSettlements(c, data, S, dpr, view0) {
  const { N } = data;
  c.save();
  c.textBaseline = "top";
  data.settlements.forEach((s, k) => {
    const x = (s.x + 0.5) * S, y = (s.y + 0.5) * S;
    const R = (s.size === 2 ? 5.2 : s.size === 1 ? 4 : 3) * dpr;
    // halo
    c.beginPath(); c.arc(x, y, R + 2.4 * dpr, 0, Math.PI * 2);
    c.fillStyle = "rgba(8,14,26,0.55)"; c.fill();
    c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2);
    c.fillStyle = s.port ? "#ffd166" : "#f4f1e8"; c.fill();
    c.lineWidth = 1.4 * dpr;
    c.strokeStyle = "rgba(20,26,38,0.9)"; c.stroke();
    if (s.port) {
      // tiny anchor tick
      c.fillStyle = "#0e2233";
      c.fillRect(x - R * 0.55, y - 1 * dpr, R * 1.1, 2 * dpr);
    }
    if (view0.showLabels) {
      const label = townName(k + data.params.seed.length, s.port) + (s.size === 2 ? " ★" : "");
      c.font = `${(s.size === 2 ? 13 : 11.5) * dpr}px Inter, system-ui, sans-serif`;
      const w = c.measureText(label).width;
      let lx = x + R + 5 * dpr, ly = y - 8 * dpr;
      if (lx + w > view.width - 8 * dpr) lx = x - R - 5 * dpr - w;
      c.fillStyle = "rgba(6,12,24,0.65)";
      c.fillRect(lx - 3 * dpr, ly - 2 * dpr, w + 6 * dpr, 18 * dpr);
      c.fillStyle = "#f2ede0";
      c.fillText(label, lx, ly);
    }
  });
  c.restore();
}

function drawPeakLabel(c, data, S, dpr) {
  const st = data.stats;
  if (st.peakM < 25) return;
  const x = (st.peakX + 0.5) * S, y = (st.peakY + 0.5) * S;
  c.save();
  c.fillStyle = "#fff";
  c.strokeStyle = "rgba(10,16,28,0.8)";
  c.lineWidth = 1.2 * dpr;
  c.beginPath();
  c.moveTo(x, y - 9 * dpr); c.lineTo(x - 6 * dpr, y + 3 * dpr); c.lineTo(x + 6 * dpr, y + 3 * dpr);
  c.closePath(); c.fill(); c.stroke();
  c.font = `${11.5 * dpr}px Inter, system-ui, sans-serif`;
  const label = `▲ ${Math.round(st.peakM)} m`;
  const w = c.measureText(label).width;
  c.fillStyle = "rgba(6,12,24,0.65)";
  c.fillRect(x + 8 * dpr, y - 12 * dpr, w + 8 * dpr, 18 * dpr);
  c.fillStyle = "#fff";
  c.fillText(label, x + 12 * dpr, y - 10 * dpr);
  c.restore();
}

function drawGraticule(c, data, S, dpr) {
  c.save();
  c.strokeStyle = "rgba(255,255,255,0.16)";
  c.lineWidth = 1;
  c.setLineDash([6 * dpr, 6 * dpr]);
  for (let k = 1; k < 5; k++) {
    const p = view.width * k / 5;
    c.beginPath(); c.moveTo(p, 0); c.lineTo(p, view.height); c.stroke();
    c.beginPath(); c.moveTo(0, p); c.lineTo(view.width, p); c.stroke();
  }
  c.setLineDash([]);
  c.restore();
}

function drawScale(c, data, dpr) {
  const kmPerPx = data.params.worldKm / view.width;
  const targetPx = 110 * dpr;
  const rawKm = targetPx * kmPerPx;
  const pow = Math.pow(10, Math.floor(Math.log10(rawKm)));
  const mult = rawKm / pow;
  const nice = mult >= 5 ? 5 : mult >= 2 ? 2 : 1;
  const km = nice * pow;
  const px = km / kmPerPx;
  const x0 = 16 * dpr, y0 = view.height - 20 * dpr;
  c.save();
  c.fillStyle = "rgba(6,12,24,0.6)";
  c.fillRect(x0 - 8 * dpr, y0 - 16 * dpr, px + 16 * dpr, 30 * dpr);
  c.fillStyle = "#fff";
  c.fillRect(x0, y0, px / 2, 3 * dpr);
  c.fillStyle = "rgba(255,255,255,0.45)";
  c.fillRect(x0 + px / 2, y0, px / 2, 3 * dpr);
  c.fillStyle = "#fff";
  c.font = `${11 * dpr}px Inter, system-ui, sans-serif`;
  c.textBaseline = "bottom";
  c.fillText(km >= 1 ? `${km} km` : `${Math.round(km * 1000)} m`, x0, y0 - 4 * dpr);
  c.restore();
}

function drawCompass(c, data, dpr, view0) {
  const wind = data.params.windDeg;
  const x0 = view.width - 34 * dpr, y0 = 34 * dpr;
  c.save();
  c.beginPath(); c.arc(x0, y0, 20 * dpr, 0, Math.PI * 2);
  c.fillStyle = "rgba(6,12,24,0.6)"; c.fill();
  c.strokeStyle = "rgba(255,255,255,0.5)"; c.lineWidth = 1 * dpr; c.stroke();
  // north needle
  c.beginPath(); c.moveTo(x0, y0 - 13 * dpr); c.lineTo(x0 - 4 * dpr, y0 + 4 * dpr); c.lineTo(x0 + 4 * dpr, y0 + 4 * dpr);
  c.closePath(); c.fillStyle = "#e63946"; c.fill();
  c.fillStyle = "#fff"; c.font = `${10 * dpr}px Inter, sans-serif`;
  c.textAlign = "center";
  c.fillText("N", x0, y0 + 12 * dpr);
  // wind arrow (small, below)
  const a = wind * Math.PI / 180;
  const wx = x0, wy = y0 + 30 * dpr;
  c.strokeStyle = "rgba(255,255,255,0.75)"; c.lineWidth = 1.4 * dpr;
  c.beginPath();
  c.moveTo(wx - Math.cos(a) * 9 * dpr, wy - Math.sin(a) * 9 * dpr);
  c.lineTo(wx + Math.cos(a) * 9 * dpr, wy + Math.sin(a) * 9 * dpr);
  c.stroke();
  c.fillStyle = "rgba(255,255,255,0.8)";
  c.font = `${8.5 * dpr}px Inter, sans-serif`;
  c.fillText("wind", wx, wy + 12 * dpr);
  c.restore();
}

// ---- stats ----
function updateStats() {
  const st = current.stats;
  const name = islandName(current.params.seed);
  try {
    if (window.root && window.root.islandName) { /* prefer pjs name occasionally */ }
  } catch (e) { /* ignore */ }
  els.statName.textContent = name;
  els.statSeed.textContent = "Seed " + current.params.seed;
  els.statArea.textContent = `${st.areaKm2.toFixed(1)} km² (${(st.landFrac * 100).toFixed(1)}% land)`;
  els.statPeak.textContent = `${Math.round(st.peakM)} m`;
  els.statRivers.textContent = `${st.riverCount} rivers · ${st.riverKm.toFixed(0)} km waterways`;
  els.statClimate.textContent = `${Math.round(st.meanTemp)}°C mean · ${(st.meanMoist * 100).toFixed(0)}% humidity`;
  els.statCoast.textContent = `${st.coastKm.toFixed(0)} km shore`;
  els.statLakes.textContent = st.lakeCells ? `${st.lakeKm2.toFixed(1)} km² water` : "none";
  // habitability: fraction of temperate/forest/grass near water
  const good = st.biomeCount[4] + st.biomeCount[5] + st.biomeCount[8] + st.biomeCount[9];
  const hab = Math.round(100 * good / Math.max(1, st.landCells));
  els.statHabit.textContent = `${hab}% fertile · ${current.settlements.length} settlements`;
  // biome bars (land + shallow)
  const items = [];
  const order = [5, 8, 9, 6, 10, 4, 7, 3, 11, 12, 13, 14, 2, 1, 0];
  const colors = { 0: "#0a2c52", 1: "#1d5f94", 2: "#4db3c4", 3: "#eee3aa", 4: "#4a7c59", 5: "#2e6e3e", 6: "#a89e5c", 7: "#e0c484", 8: "#427642", 9: "#7a9854", 10: "#345c48", 11: "#949e8a", 12: "#7a746c", 13: "#f0f4f8", 14: "#468cb4" };
  for (const b of order) {
    const f = st.biomeFrac[b];
    if (f < 0.004) continue;
    items.push(`<div class="brow"><span class="bdot" style="background:${colors[b]}"></span><span class="bname">${BIOME_NAMES[b]}</span><span class="btrack"><span class="bfill" style="width:${(f * 100).toFixed(1)}%;background:${colors[b]}"></span></span><span class="bpct">${(f * 100).toFixed(1)}%</span></div>`);
  }
  els.biomeBars.innerHTML = items.join("");
  buildLegend();
}

function buildLegend() {
  const style = renderOpts?.style || "satellite";
  if (style === "biome") {
    els.legend.innerHTML = `<b>Biomes</b>` + [[5, "Rainforest"], [8, "Temperate forest"], [9, "Grassland"], [6, "Savanna"], [7, "Desert"], [10, "Taiga"], [11, "Tundra"], [3, "Beach"], [4, "Mangrove"], [12, "Rock"], [13, "Snow"], [14, "Lake"], [2, "Shelf"], [0, "Deep"]].map(([i, n]) => `<span><i style="background:${["#0a2c52", "#1d5f94", "#4db3c4", "#eee3aa", "#4a7c59", "#2e6e3e", "#a89e5c", "#e0c484", "#427642", "#7a9854", "#345c48", "#949e8a", "#7a746c", "#f0f4f8", "#468cb4"][i]}"></i>${n}</span>`).join("");
  } else if (style === "topo") {
    els.legend.innerHTML = `<b>Topographic</b><span><i style="background:#e8c88a"></i>lowlands</span><span><i style="background:#96684a"></i>highlands</span><span><i style="background:#fafafa"></i>peaks</span><span><i style="background:#1e5a96"></i>ocean</span><span>― 60 m minor · ― 300 m major</span>`;
  } else if (style === "climate") {
    els.legend.innerHTML = `<b>Climate</b><span><i style="background:#3c78c8"></i>cold / wet</span><span><i style="background:#d7d7d7"></i>mild</span><span><i style="background:#d7584a"></i>hot / dry</span>`;
  } else if (style === "height") {
    els.legend.innerHTML = `<b>Elevation</b><span><i style="background:#111"></i>low</span><span><i style="background:#888"></i>mid</span><span><i style="background:#fff"></i>high</span>`;
  } else {
    els.legend.innerHTML = `<b>Satellite</b><span><i style="background:#0b2a4a"></i>deep</span><span><i style="background:#40aac4"></i>shelf / reef</span><span><i style="background:#f5f5f5"></i>surf</span><span><i style="background:#eeddAA"></i>beach</span><span><i style="background:#2e6e3e"></i>forest</span><span><i style="background:#e0c484"></i>arid</span><span><i style="background:#f0f4f8"></i>snow</span>`;
  }
}

// ---- share / export ----
function writeHash(p) {
  const q = new URLSearchParams({
    seed: p.seed, size: p.size, type: p.islandType,
    isl: p.islandSize.toFixed(2), sea: p.seaLevel.toFixed(2),
    cpx: p.complexity.toFixed(2), mtn: p.mountains.toFixed(2),
    rain: p.rainfall.toFixed(2), tmp: p.temperature.toFixed(2),
    ero: p.erosion.toFixed(2), warp: p.warp.toFixed(2),
    wind: Math.round(p.windDeg), arch: p.archipelago.toFixed(2), km: p.worldKm,
  });
  history.replaceState(null, "", "#" + q.toString());
}
function readHash() {
  if (!location.hash || location.hash.length < 3) return false;
  try {
    const q = new URLSearchParams(location.hash.slice(1));
    if (q.get("seed")) els.seedInput.value = q.get("seed");
    if (q.get("size")) els.sizeSel.value = q.get("size");
    if (q.get("type")) els.typeSel.value = q.get("type");
    const set = (id, v) => { if (v != null && !isNaN(parseFloat(v))) document.getElementById(id).value = parseFloat(v); };
    set("islandSize", q.get("isl")); set("seaLevel", q.get("sea"));
    set("complexity", q.get("cpx")); set("mountains", q.get("mtn"));
    set("rainfall", q.get("rain")); set("temperature", q.get("tmp"));
    set("erosion", q.get("ero")); set("warp", q.get("warp"));
    set("archipelago", q.get("arch"));
    if (q.get("wind")) els.windDeg.value = q.get("wind");
    if (q.get("km")) els.worldKm.value = q.get("km");
    return true;
  } catch (e) { return false; }
}

// ---- events ----
function bind() {
  document.querySelectorAll("input[type=range], select.sortable").forEach(el => {
    el.addEventListener("input", syncLabels);
  });
  document.querySelectorAll("#panel input, #panel select").forEach(el => {
    el.addEventListener("input", syncLabels);
  });
  // live repaint for view-only controls
  ["sunAz", "hillStrength"].forEach(id => {
    els[id].addEventListener("input", () => { if (current && !generating) paint(); });
  });
  ["showRivers", "showLabels", "showRoads", "showContours", "showGrid", "showReef"].forEach(id => {
    els[id].addEventListener("change", () => { if (current && !generating) { paint(); buildLegend(); } });
  });
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      if (current && !generating) { paint(); buildLegend(); }
    });
  });
  els.regenBtn.addEventListener("click", () => regenerate());
  els.newBtn.addEventListener("click", () => regenerate(randomSeed()));
  els.diceBtn.addEventListener("click", () => { els.seedInput.value = randomSeed(); regenerate(); });
  els.surpriseBtn.addEventListener("click", () => {
    const R = (a, b) => a + Math.random() * (b - a);
    const types = ["continental", "volcanic", "atoll", "archipelago", "continental", "continental"];
    els.typeSel.value = types[(Math.random() * types.length) | 0];
    els.islandSize.value = R(0.38, 0.66).toFixed(2);
    els.seaLevel.value = R(0.36, 0.5).toFixed(3);
    els.complexity.value = R(0.35, 1).toFixed(2);
    els.mountains.value = R(0.2, 0.95).toFixed(2);
    els.rainfall.value = R(0.05, 0.95).toFixed(2);
    els.temperature.value = R(0.15, 0.95).toFixed(2);
    els.erosion.value = R(0.3, 0.85).toFixed(2);
    els.warp.value = R(0.3, 0.9).toFixed(2);
    els.archipelago.value = R(0, 0.8).toFixed(2);
    els.windDeg.value = Math.round(R(0, 360));
    syncLabels();
    regenerate(randomSeed());
  });
  els.seedInput.addEventListener("input", () => {
    els.seedInput.value = els.seedInput.value.replace(/\D/g, "").slice(0, 6);
  });
  els.seedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") regenerate(); });
  // terrain sliders trigger resim only on release (change), live label on input
  ["islandSize", "seaLevel", "complexity", "mountains", "rainfall", "temperature", "erosion", "warp", "windDeg", "archipelago", "worldKm", "sizeSel", "typeSel"].forEach(id => {
    els[id]?.addEventListener("change", () => regenerate());
  });
  els.dlBtn.addEventListener("click", () => {
    if (!current) return;
    const a = document.createElement("a");
    const name = (els.statName.textContent || "island").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    a.download = `isleforge-${name}-${current.params.seed}.png`;
    a.href = view.toDataURL("image/png");
    a.click();
  });
  els.linkBtn.addEventListener("click", async () => {
    const url = location.href;
    try { await navigator.clipboard.writeText(url); els.linkBtn.textContent = "Copied"; }
    catch (e) {
      prompt("Copy this link:", url);
      return;
    }
    setTimeout(() => els.linkBtn.textContent = "Copy link", 1600);
  });
  window.addEventListener("resize", () => { if (current && !generating) paint(); });
  // presets
  document.querySelectorAll("[data-preset]").forEach(b => {
    b.addEventListener("click", () => {
      const p = b.dataset.preset;
      if (p === "volcanic") { els.typeSel.value = "volcanic"; els.mountains.value = 0.8; els.islandSize.value = 0.5; els.erosion.value = 0.45; }
      if (p === "atoll") { els.typeSel.value = "atoll"; els.mountains.value = 0.15; els.seaLevel.value = 0.46; els.islandSize.value = 0.55; els.temperature.value = 0.85; els.rainfall.value = 0.7; }
      if (p === "archipelago") { els.typeSel.value = "archipelago"; els.archipelago.value = 0.8; els.islandSize.value = 0.42; }
      if (p === "continental") { els.typeSel.value = "continental"; els.mountains.value = 0.62; els.islandSize.value = 0.55; els.rainfall.value = 0.55; }
      if (p === "desert") { els.typeSel.value = "continental"; els.rainfall.value = 0.12; els.temperature.value = 0.85; els.mountains.value = 0.5; }
      if (p === "fjord") { els.typeSel.value = "continental"; els.mountains.value = 0.9; els.rainfall.value = 0.7; els.temperature.value = 0.3; els.complexity.value = 0.85; els.erosion.value = 0.7; }
      syncLabels();
      regenerate();
    });
  });
}

bind();
syncLabels();
const fromLink = readHash();
syncLabels();
if (!els.seedInput.value) els.seedInput.value = randomSeed();
regenerate();
window.isleforge = { regenerate, paint, get current() { return current; } };

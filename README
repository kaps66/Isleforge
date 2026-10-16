# Isleforge — Realistic 2D Island Generator

Procedural islands with real simulation behind them, rendered as satellite,
topographic, biome, climate, and heightmap cartography.

## Architecture

- `main.pjs` — generator metadata (`$meta`) + a few perchance name lists.
  Kept light on purpose; all logic is in `src/`.
- `index.html` — UI shell (body only): top bar, control panel, map card, legend.
- `src/engine.js` — pure simulation, no DOM:
  seeded value/gradient noise + fBm + domain warp → island falloff shaping
  (continental / volcanic cone+crater / atoll ring+lagoon / archipelago /
  seamount) → percentile normalize → droplet hydraulic erosion + thermal
  talus → rim-sealed lake basins stamped on valley floors → priority-flood
  depression fill → D8 flow accumulation → river tracing + adaptive lake
  detection → lapse-rate/orographic climate model → Whittaker biome
  classifier → settlement siting. Exports `generateIsland(params,
  onProgress)`, `islandName(seed)`, `hashSeed`, `BIOME` ids.
- `src/render.js` — `paintBase` (per-pixel ImageData for each map style),
  `computeHillshade`, `drawContours` (display-pixel space).
- `src/app.js` — controls → params, progress overlay, display upscaling,
  vector overlays (rivers, towns, peak, graticule, scale bar, compass),
  survey stats, share-link hash (`#seed=…&…`), PNG export.

## Key tunables (if a future session rebalances)

- Coastline: `wobble` amplitude in `generateIsland` falloff loop; falloff
  exponent `1.7` controls lowland-vs-peak hypsometry.
- Erosion cost: droplet iterations `N²·(0.03+ero·0.30)·0.55` — the main
  generation-time driver (~15–20k droplets at 384²).
- Rock/treeline: `hM > 1750`, alpine overrides at `0.82/0.93 × maxElevM`,
  slope-rock gated by `hM > 300` so atolls stay sandy.
- Rivers: `minAcc = N²/900`, max 26; widths in `drawRivers` (app.js).
- `autoMaxElev`: `350 + mountains·2600` (volcanic higher, atoll capped 220m).

## Verified

Satellite / topo (contours) / biome / climate views, atoll ring shape,
river overlay, settlements with roads + farmland, river names, depth
soundings, PNG export, share hash, 390px mobile layout (no overflow).
Seeds are numeric-only (legacy text seeds fold to numbers). Generation is
async with progress; view-only controls (sun, layers, style) repaint
without resimulation.

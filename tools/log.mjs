// ฝนจะตกไหมชาเย็น — forecast logger + verifier.
// Runs on a schedule (GitHub Actions). Each run:
//   1. computes the same 16 x 15-min forecast the page shows, and appends it to forecasts.csv
//   2. records whether the radar saw rain over the farm in each recent 10-min frame (observed.csv)
//   3. matches past forecasts against observations and writes scores to verify.json
// The forecast maths is read straight out of ../index.html so the page and the logger never drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const fetchFn = globalThis.__fetch || fetch;

/* ---------- shared maths from the page ---------- */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const coreSrc = html.slice(html.indexOf('/* ===== Core'), html.indexOf('/* ===== App'));
const { Core, Past } = new Function('module', coreSrc.replace(/if \(typeof module[^\n]*\n/g, '') + '\nreturn { Core, Past };')(undefined);
const LAT = +(process.env.LAT || html.match(/parseFloat\(qs\.get\('lat'\)\) \|\| ([\d.]+)/)[1]);
const LON = +(process.env.LON || html.match(/parseFloat\(qs\.get\('lon'\)\) \|\| ([\d.]+)/)[1]);

const W = 768, H = 768;
const P = Core.lonLatToPx(LON, LAT);
const tileX0 = Math.floor(P.x / 256) - 1, tileY0 = Math.floor(P.y / 256) - 1;
const px = P.x - tileX0 * 256, py = P.y - tileY0 * 256;
const ENS_MODELS = ['ecmwf_ifs025', 'gfs025', 'icon_seamless'];
const DET_MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'jma_seamless', 'gem_seamless', 'cma_grapes_global'];
const OM = 'https://api.open-meteo.com/v1/forecast', OME = 'https://ensemble-api.open-meteo.com/v1/ensemble';

async function getJSON(u) { const r = await fetchFn(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); }
async function getBuf(u) { const r = await fetchFn(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return Buffer.from(await r.arrayBuffer()); }

/* ---------- radar ---------- */
async function loadFrame(host, p) {
  const mask = new Uint8Array(W * H); let ok = 0;
  await Promise.all([0, 1, 2].flatMap(j => [0, 1, 2].map(async i => {
    try {
      const png = PNG.sync.read(await getBuf(`${host}${p}/256/${Core.Z}/${tileX0 + i}/${tileY0 + j}/2/0_0.png`));
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++)
        if (png.data[(y * png.width + x) * 4 + 3] > 60) mask[(j * 256 + y) * W + i * 256 + x] = 1;
      ok++;
    } catch (e) { /* missing tile = no data for that square */ }
  })));
  return ok ? mask : null;
}
async function loadRadar() {
  const meta = await getJSON('https://api.rainviewer.com/public/weather-maps.json');
  const past = (meta.radar && meta.radar.past || []).slice(-12);
  const frames = [];
  for (const f of past) frames.push({ time: f.time, mask: await loadFrame(meta.host, f.path) });
  return frames.filter(f => f.mask);
}

/* ---------- models ---------- */
async function loadModels(now) {
  const q = `latitude=${LAT}&longitude=${LON}&forecast_hours=7&past_hours=1&timeformat=unixtime`;
  const ens = await Promise.allSettled(ENS_MODELS.map(m => getJSON(`${OME}?${q}&hourly=precipitation&models=${m}`).then(j => ({ m, j }))));
  const det = await Promise.allSettled(DET_MODELS.map(m => getJSON(`${OM}?${q}&hourly=precipitation,precipitation_probability&models=${m}`).then(j => ({ m, j }))));
  const wind = await getJSON(`${OM}?latitude=${LAT}&longitude=${LON}&hourly=wind_speed_700hPa,wind_direction_700hPa&forecast_hours=2&timeformat=unixtime`).catch(() => null);
  return { now, ens: ens.filter(r => r.status === 'fulfilled').map(r => r.value), det: det.filter(r => r.status === 'fulfilled').map(r => r.value), wind };
}
// same weighting as the page
function modelProbAt(models, tSec) {
  const parts = [];
  for (const { j } of models.ens) { const i = Core.hourIndexFor(j.hourly.time, tSec); if (i < 0) continue; const e = Core.ensembleFrac(j.hourly, i); if (e) parts.push({ p: e.p, w: 2 }); }
  let dk = 0, dn = 0; const pp = [];
  for (const { j } of models.det) {
    const i = Core.hourIndexFor(j.hourly.time, tSec); if (i < 0) continue;
    const v = j.hourly.precipitation[i]; if (v != null) { dn++; if (v >= 0.2) dk++; }
    const qv = j.hourly.precipitation_probability && j.hourly.precipitation_probability[i]; if (qv != null) pp.push(qv / 100);
  }
  if (dn) parts.push({ p: dk / dn, w: 1.5 });
  if (pp.length) parts.push({ p: pp.reduce((a, b) => a + b, 0) / pp.length, w: 1 });
  if (!parts.length) return null;
  return parts.reduce((a, b) => a + b.p * b.w, 0) / parts.reduce((a, b) => a + b.w, 0);
}
function analyseRadar(ok, models) {
  if (ok.length < 2) return null;
  const last = ok[ok.length - 1], pairs = [];
  for (const back of [3, 2]) {
    const a = ok[ok.length - 1 - back]; if (!a) continue;
    const dt = (last.time - a.time) / 60; if (dt <= 0) continue;
    const m = Core.estimateMotion(a.mask, last.mask, W, H, Math.round(px), Math.round(py), 150, 14, 2);
    if (m.conf > 0) pairs.push({ vx: m.dx / dt, vy: m.dy / dt, conf: m.conf });
  }
  let vx = 0, vy = 0, conf = 0, source = 'none';
  if (pairs.length) {
    const sw = pairs.reduce((a, b) => a + b.conf, 0);
    vx = pairs.reduce((a, b) => a + b.vx * b.conf, 0) / sw; vy = pairs.reduce((a, b) => a + b.vy * b.conf, 0) / sw;
    conf = Math.min(1, sw / pairs.length * 2); source = 'radar';
  }
  if (conf < 0.25 && models && models.wind && models.wind.hourly) {
    const h = models.wind.hourly, i = Math.max(0, Core.hourIndexFor(h.time, models.now) - 1);
    const sp = h.wind_speed_700hPa[i], dr = h.wind_direction_700hPa[i];
    if (sp != null && dr != null) { const s = Core.steeringFromWind(sp, dr, LAT); vx = s.vx; vy = s.vy; conf = 0.3; source = 'wind'; }
  }
  return { last, vx, vy, conf, source };
}

/* ---------- csv helpers ---------- */
function readCSV(f) {
  if (!fs.existsSync(f)) return [];
  const [head, ...rows] = fs.readFileSync(f, 'utf8').trim().split('\n'); if (!head) return [];
  const k = head.split(',');
  return rows.filter(Boolean).map(r => Object.fromEntries(r.split(',').map((v, i) => [k[i], v])));
}
function appendCSV(f, header, rows) {
  if (!rows.length) return;
  const exists = fs.existsSync(f) && fs.statSync(f).size > 0;
  fs.appendFileSync(f, (exists ? '' : header.join(',') + '\n') + rows.map(r => header.map(h => r[h] ?? '').join(',')).join('\n') + '\n');
}
const iso = s => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const r3 = v => (v == null ? '' : Math.round(v * 1000) / 1000);

/* ---------- verification ---------- */
function verify(fc, obs) {
  const obsTimes = obs.map(o => ({ t: Date.parse(o.frame_time) / 1000, wet: o.wet === '1' }));
  const newest = obsTimes.reduce((m, o) => Math.max(m, o.t), 0);
  const pairs = [];
  for (const f of fc) {
    const t0 = Date.parse(f.target) / 1000, t1 = t0 + 900;
    if (t1 > newest) continue;                                   // not observed yet
    const inSlot = obsTimes.filter(o => o.t >= t0 && o.t < t1);
    if (!inSlot.length) continue;                                // radar gap
    const y = inSlot.some(o => o.wet) ? 1 : 0, lead = +f.lead_min;
    for (const k of ['p', 'p_radar', 'p_model']) if (f[k] !== '') pairs.push({ k, p: +f[k], y, lead, hour: new Date((t0 + 7 * 3600) * 1000).getUTCHours() });
  }
  const buckets = [[0, 30], [30, 60], [60, 120], [120, 241]];
  const summarize = (list) => {
    const n = list.length; if (!n) return { n: 0 };
    const brier = list.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / n, base = list.reduce((a, x) => a + x.y, 0) / n;
    const bs_clim = base * (1 - base);
    return { n, brier: r3(brier), base_rate: r3(base), skill_vs_climatology: bs_clim > 0 ? r3(1 - brier / bs_clim) : null };
  };
  const out = { generated: new Date().toISOString(), lat: LAT, lon: LON, truth: 'radar over the farm (any wet 10-min frame inside the 15-min slot)', components: {} };
  for (const k of ['p', 'p_radar', 'p_model']) {
    const L = pairs.filter(x => x.k === k);
    const rel = [];
    for (let b = 0; b < 10; b++) { const s = L.filter(x => Math.min(9, Math.floor(x.p * 10)) === b);
      if (s.length) rel.push({ bin: `${b * 10}-${b * 10 + 10}%`, n: s.length, mean_forecast: r3(s.reduce((a, x) => a + x.p, 0) / s.length), observed_freq: r3(s.reduce((a, x) => a + x.y, 0) / s.length) }); }
    out.components[k] = { all: summarize(L), by_lead: Object.fromEntries(buckets.map(([a, b]) => [`${a}-${Math.min(b, 240)}min`, summarize(L.filter(x => x.lead >= a && x.lead < b))])), reliability: rel };
  }
  return out;
}

/* ---------- reports from the app (GitHub issues titled [รายงานฝน]) ---------- */
async function loadReports() {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return null;
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetchFn(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}`,
      { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'chayen-log' } });
    if (!r.ok) throw new Error(`issues ${r.status}`);
    const list = await r.json(); if (!list.length) break;
    for (const it of list) {
      if (it.pull_request || !String(it.title || '').startsWith('[รายงานฝน]')) continue;
      if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(it.author_association)) continue;   // public repo: only trust the owner's reports
      const m = String(it.body || '').match(/```chayen-report([\s\S]*?)```/); if (!m) continue;
      const kv = Object.fromEntries(m[1].split('\n').map(l => l.match(/^\s*([a-z_]+):\s*(.*?)\s*$/)).filter(Boolean).map(x => [x[1], x[2]]));
      if (!['rain', 'dry'].includes(kv.observed) || !Date.parse(kv.at)) continue;
      out.push({ issue: it.number, at: new Date(kv.at).toISOString().replace('.000Z', 'Z'), observed: kv.observed,
        app_p_now: kv.forecast_p_now ?? '', app_radar_now: kv.radar_now ?? '' });
    }
    if (list.length < 100) break;
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
function scoreReports(reports, fc, obs) {
  const rows = reports.map(r => {
    const T = Date.parse(r.at) / 1000;
    const inSlot = fc.filter(f => { const t0 = Date.parse(f.target) / 1000; return T >= t0 && T < t0 + 900 && Date.parse(f.issued) / 1000 <= T; });
    const latest = inSlot.sort((a, b) => b.issued.localeCompare(a.issued))[0];
    const ahead = inSlot.filter(f => +f.lead_min >= 60 && +f.lead_min <= 120).sort((a, b) => b.issued.localeCompare(a.issued))[0];
    const near = obs.filter(o => Math.abs(Date.parse(o.frame_time) / 1000 - T) <= 600);
    return { ...r, p_latest: latest ? latest.p : '', p_1to2h_ahead: ahead ? ahead.p : '',
      radar_wet_pm10min: near.length ? (near.some(o => o.wet === '1') ? 1 : 0) : '' };
  });
  const y = r => (r.observed === 'rain' ? 1 : 0);
  const conf = (list, key) => {
    const L = list.filter(r => r[key] !== ''); const c = { n: L.length, hit: 0, miss: 0, false_alarm: 0, correct_dry: 0 };
    for (const r of L) { const f = +r[key] >= 0.5 ? 1 : 0, o = y(r); c[f && o ? 'hit' : !f && o ? 'miss' : f && !o ? 'false_alarm' : 'correct_dry']++; }
    return c;
  };
  const rad = rows.filter(r => r.radar_wet_pm10min !== '');
  return { rows, summary: {
    n: rows.length, observed_rain: rows.filter(r => y(r)).length,
    forecast_latest: conf(rows, 'p_latest'), forecast_1to2h_ahead: conf(rows, 'p_1to2h_ahead'),
    radar_agrees_with_report: rad.length ? r3(rad.filter(r => r.radar_wet_pm10min === y(r)).length / rad.length) : null, radar_compared: rad.length,
    note: 'threshold 50%; miss = said dry but it rained, false_alarm = said rain but it stayed dry' } };
}

/* ---------- main ---------- */
export async function run() {
  fs.mkdirSync(DATA, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const [radR, modR] = await Promise.allSettled([loadRadar(), loadModels(now)]);
  const frames = radR.status === 'fulfilled' ? radR.value : [];
  const models = modR.status === 'fulfilled' ? modR.value : null;
  const radar = analyseRadar(frames, models);

  // 1. forecast rows
  const start = Math.ceil(now / 900) * 900, radarAge = radar ? (now - radar.last.time) / 60 : 0, slots = [];
  for (let k = 0; k < 16; k++) {
    const tSec = start + k * 900, t = Math.round((tSec - now) / 60);
    const r = radar && t + radarAge < 125 ? Core.radarProb(radar.last.mask, W, H, px, py, radar.vx, radar.vy, t + radarAge, radar.conf) : null;
    slots.push({ t: Math.max(0, t), tSec, radar: r, model: models ? modelProbAt(models, tSec) : null });
  }
  const blended = Core.blend(slots);
  appendCSV(path.join(DATA, 'forecasts.csv'), ['issued', 'target', 'lead_min', 'p', 'p_radar', 'p_model', 'motion', 'motion_conf', 'radar_age_min'],
    blended.filter(s => s.p != null).map(s => ({ issued: iso(now), target: iso(s.tSec), lead_min: s.t, p: r3(s.p), p_radar: r3(s.radar), p_model: r3(s.model),
      motion: radar ? radar.source : 'none', motion_conf: radar ? r3(radar.conf) : '', radar_age_min: radar ? Math.round(radarAge) : '' })));

  // 2. observations (one row per radar frame, no duplicates)
  const obsFile = path.join(DATA, 'observed.csv');
  const seen = new Set(readCSV(obsFile).map(o => o.frame_time));
  appendCSV(obsFile, ['frame_time', 'wet', 'frac_1km', 'frac_5km'], frames.map(f => ({
    frame_time: iso(f.time), wet: (Core.fracInDisk(f.mask, W, H, px, py, 1.5) || 0) >= 0.5 ? 1 : 0,
    frac_1km: r3(Core.fracInDisk(f.mask, W, H, px, py, 1.5)), frac_5km: r3(Core.fracInDisk(f.mask, W, H, px, py, 5 / Core.kmPerPx(LAT)))
  })).filter(r => !seen.has(r.frame_time)).sort((a, b) => a.frame_time.localeCompare(b.frame_time)));

  // 3. scores
  const v = verify(readCSV(path.join(DATA, 'forecasts.csv')), readCSV(obsFile));
  const reports = await loadReports().catch(e => { console.error('reports:', e.message); return null; });
  if (reports) {
    const sr = scoreReports(reports, readCSV(path.join(DATA, 'forecasts.csv')), readCSV(obsFile));
    const head = ['issue', 'at', 'observed', 'p_latest', 'p_1to2h_ahead', 'radar_wet_pm10min', 'app_p_now', 'app_radar_now'];
    fs.writeFileSync(path.join(DATA, 'reports.csv'), head.join(',') + '\n' + sr.rows.map(r => head.map(h => r[h] ?? '').join(',')).join('\n') + (sr.rows.length ? '\n' : ''));
    v.reports = sr.summary;
  }
  v.last_run = { at: iso(now), radar_frames: frames.length, models_ok: models ? models.ens.length + models.det.length : 0, motion: radar ? radar.source : 'none' };
  fs.writeFileSync(path.join(DATA, 'verify.json'), JSON.stringify(v, null, 2) + '\n');
  console.log(`run ${iso(now)} · frames ${frames.length} · models ${v.last_run.models_ok} · verified pairs ${v.components.p.all.n}`);
  return v;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) run().catch(e => { console.error(e); process.exit(1); });

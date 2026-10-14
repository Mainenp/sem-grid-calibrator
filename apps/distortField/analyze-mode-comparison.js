// Read-only re-analysis to recover mode details omitted from the CSV export.
const fs = require('fs');
const path = require('path');
const { analyze } = require('./server');

function csv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift();
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}
function key(filename) {
  const m = filename.match(/^([\d.]+)kv-(\d+)(k?)x-(\d+)k_/i);
  return [Number(m[1]), Number(m[2]) * (m[3] ? 1000 : 1), Number(m[4])].join('/');
}
function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { p95: sorted[Math.floor(.95 * (sorted.length - 1))],
    rms: Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length) };
}
async function main() {
  const config=process.argv[2];
  if(!config) throw new Error('Usage: node analyze-mode-comparison.js batches.json');
  const input=JSON.parse(fs.readFileSync(config,'utf8'));
  if(!Array.isArray(input)||input.length!==2||input.some(s=>!s.batch||!s.csv||!s.dir)) {
    throw new Error('Configuration must contain two records with batch, csv and dir');
  }
  const base=path.dirname(path.resolve(config));
  const specs=input.map(s=>({...s,csv:path.resolve(base,s.csv),dir:path.resolve(base,s.dir)}));
  const sets = specs.map(s => csv(fs.readFileSync(s.csv, 'utf8')));
  const records = [];
  for (let i = 0; i < 2; i++) for (const source of sets[i]) {
    const k=key(source.filename), spec=specs[i];
    let result;
    try { result = await analyze(path.join(spec.dir, source.filename), { filename: source.filename, makeMask: false, cacheResult: false }); }
    catch(error) { records.push({key:k,batch:spec.batch,filename:source.filename,quality:'error',error:error.message});console.log(spec.batch,source.filename,'ERROR',error.message);continue; }
    const d = result.distortion.decomposition, affineModes = {};
    for (const mode of ['uniformScale', 'differentialScale', 'shear', 'rotationLike']) {
      // Each elementary affine matrix has magnitude |coefficient| * radius.
      affineModes[mode] = stats(result.distortion.samples.map(p => Math.abs(d.affine[mode]) * Math.hypot(p.idealX - d.center.x, p.idealY - d.center.y)));
    }
    records.push({ key: k, batch: spec.batch, filename: source.filename, width: result.image.width,
      quality: result.quality.status, warnings:result.quality.warnings, originalQuality: source.qualityStatus,
      angle:result.rectification?.includedAngleDegrees,pitch:result.pitch,
      detected:result.squareExtraction.detected,expected:result.squareExtraction.expected,
      total: result.distortion.stats, modes: d.stats, affineCoefficients: d.affine, affineModes,
      fitResidual: result.distortion.fitResidualStats,
      originalP95: source.p95Px?Number(source.p95Px):null, reproductionDifference: source.p95Px?result.distortion.stats.p95 - Number(source.p95Px):null });
    console.log(spec.batch, source.filename, 'P95', result.distortion.stats.p95.toFixed(3));
  }
  const out = path.join(__dirname, 'results', '2026-10-08-modes', 'paired-modes.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ selection: 'All 58 source files reanalyzed with current code; pair by voltage/magnification/resolution', records }, null, 2));
  console.log('Saved', out);
}
main().catch(e => { console.error(e); process.exitCode = 1; });

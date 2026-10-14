const { analyze } = require('./server');
const sharp = require('sharp');
const path = require('path');

(async () => {
  const result = await analyze();
  if (result.vertical.length < 40 || result.horizontal.length < 40) throw new Error('Too few grid lines detected');
  if (result.pitch.x < 30 || result.pitch.x > 100 || result.pitch.y < 30 || result.pitch.y > 100) throw new Error('Implausible grid pitch');
  if (result.source.magnification !== 2000 || result.quality.status !== 'ok') throw new Error('Acquisition parsing or quality control failed');
  const refined = result.centers.filter(center => center.refinementPixels > 0);
  if (refined.length < result.centers.length * .95) throw new Error('Too few square centers refined at full resolution');
  const refinementDistances = refined.map(center => center.refinementPixels).sort((a,b) => a-b);
  const refinementP95 = refinementDistances[Math.floor((refinementDistances.length - 1) * .95)];
  if (refinementP95 > 4) throw new Error(`Unstable center refinement (${refinementP95.toFixed(2)} px p95)`);
  if (!refined.every(center => Number.isFinite(center.thresholdStability) && Number.isFinite(center.symmetrySpread))) {
    throw new Error('Subpixel refinement diagnostics are invalid');
  }
  const nonlinearStats = result.distortion.decomposition.stats.nonlinear;
  if (![nonlinearStats.mean, nonlinearStats.rms, nonlinearStats.p95, nonlinearStats.max].every(Number.isFinite)) {
    throw new Error('Nonlinear distortion statistics are invalid');
  }
  const lineResidual=result.quality.lineFitResidual;
  if(lineResidual.horizontal.p95>result.pitch.y*.05||lineResidual.vertical.p95>result.pitch.x*.05) {
    throw new Error(`Grid line assignment is inconsistent (${lineResidual.horizontal.p95.toFixed(2)} / ${lineResidual.vertical.p95.toFixed(2)} px p95)`);
  }
  for (const [name, lines, coordinate, pitch] of [
    ['vertical', result.vertical, 'x1', result.pitch.x],
    ['horizontal', result.horizontal, 'y1', result.pitch.y]
  ]) {
    const sorted = lines.map(line => line[coordinate]).sort((a, b) => a - b);
    const largestGap = Math.max(...sorted.slice(1).map((value, i) => value - sorted[i]));
    if (largestGap > pitch * 1.6) throw new Error(`${name} lattice contains a missing line (${largestGap.toFixed(1)} px gap)`);
  }
  console.log(`Detected ${result.vertical.length} vertical and ${result.horizontal.length} horizontal lines`);
  console.log(`Pitch: ${result.pitch.x.toFixed(2)} × ${result.pitch.y.toFixed(2)} px`);
  console.log(`Full-resolution center refinement p95: ${refinementP95.toFixed(2)} px`);
  console.log(`Nonlinear distortion p95: ${nonlinearStats.p95.toFixed(2)} px`);
  const sx = 1200 / result.image.width;
  const sh = Math.round(result.image.height * sx);
  const lines = [
    ...result.vertical.map(l => `<polyline points="${l.points.map(p=>`${p.x*sx},${p.y*sx}`).join(' ')}" fill="none" stroke="#20e0d5"/>`),
    ...result.horizontal.map(l => `<polyline points="${l.points.map(p=>`${p.x*sx},${p.y*sx}`).join(' ')}" fill="none" stroke="#ff9850"/>`)
  ].join('');
  const overlay = Buffer.from(`<svg width="1200" height="${sh}" xmlns="http://www.w3.org/2000/svg"><g stroke-width="1" opacity=".9">${lines}</g></svg>`);
  await sharp(path.join(__dirname, 'data', '0.5kv-2000x-4K_07.tif'))
    .resize({ width: 1200 }).composite([{ input: overlay }]).png().toFile('.tmp_overlay.png');
  const ceiling = result.distortion.stats.p95;
  const heat = result.distortion.samples.map(p => {
    const t = Math.min(1, p.magnitude / ceiling);
    const hue = 270 * (1 - t);
    return `<rect x="${(p.x-result.pitch.x*.47)*sx}" y="${(p.y-result.pitch.y*.47)*sx}" width="${result.pitch.x*.94*sx}" height="${result.pitch.y*.94*sx}" fill="hsl(${hue} 90% 52%)"/>`;
  }).join('');
  const heatSvg = Buffer.from(`<svg width="1200" height="${sh}" xmlns="http://www.w3.org/2000/svg"><g opacity=".5">${heat}</g></svg>`);
  await sharp(path.join(__dirname, 'data', '0.5kv-2000x-4K_07.tif'))
    .resize({ width: 1200 }).composite([{ input: heatSvg }]).png().toFile('.tmp_distortion_overlay.png');
  console.log('Wrote visual verification overlay to .tmp_overlay.png');
})();

const fs = require('fs');
const path = require('path');
const { analyze } = require('./server');
const units = require('./public/units');

const inputDirectory = path.resolve(process.argv[2] || path.join(__dirname, 'data'));
const outputDirectory = path.resolve(process.argv[3] || path.join(__dirname, 'results', path.basename(inputDirectory)));
const summaryOnly = process.argv.includes('--summary-only');

function csv(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

(async () => {
  const files = fs.readdirSync(inputDirectory)
    .filter(name => /\.tiff?$/i.test(name))
    .sort();
  if (!files.length) throw new Error(`No TIFF images found in ${inputDirectory}`);
  fs.mkdirSync(outputDirectory, { recursive:true });
  const rows = [];
  for (const [index, name] of files.entries()) {
    const filename = path.join(inputDirectory, name);
    const started = Date.now();
    process.stdout.write(`[${index + 1}/${files.length}] ${name} ... `);
    try {
      const result = await analyze(filename, { makeMask:false, cacheResult:false });
      if (!summaryOnly) fs.writeFileSync(
        path.join(outputDirectory, `${path.parse(name).name}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
        'utf8'
      );
      rows.push({
        filename:name,status:'ok',error:'',voltageKv:result.source.voltageKv,
        magnification:result.source.magnification,resolutionK:result.source.resolutionK,
        width:result.image.width,height:result.image.height,pitchX:result.pitch.x,pitchY:result.pitch.y,
        detected:result.squareExtraction.detected,expected:result.squareExtraction.expected,
        recovered:result.squareExtraction.recovered,
        qualityStatus:result.quality.status,warnings:result.quality.warnings.join('; '),
        minRowCoverage:result.quality.minimumInteriorRowCoverage,
        minColumnCoverage:result.quality.minimumInteriorColumnCoverage,
        fitSamples:result.distortion.fitSampleCount,meanPx:result.distortion.stats.mean,
        rmsPx:result.distortion.stats.rms,p95Px:result.distortion.stats.p95,maxPx:result.distortion.stats.max,
        fitResidualP95Px:result.distortion.fitResidualStats.p95,
        affineP95Px:result.distortion.decomposition.stats.affine.p95,
        nonlinearP95Px:result.distortion.decomposition.stats.nonlinear.p95,
        radialP95Px:result.distortion.decomposition.stats.radial.p95,
        tangentialP95Px:result.distortion.decomposition.stats.tangential.p95,
        rowTiltDeg:result.rectification?.rowTiltDegrees,
        columnTiltDeg:result.rectification?.columnTiltDegrees,
        includedAngleDeg:result.rectification?.includedAngleDegrees,
        orthogonalityErrorDeg:result.rectification?.orthogonalityErrorDegrees,
        rectifiedPitchPx:result.rectification?.targetPitchPx,
        clusterColumnPeriod:result.distortion.referenceLattice?.column.period,
        clusterRowPeriod:result.distortion.referenceLattice?.row.period,
        nanometersPerPixel:result.distortion.physical.nanometersPerPixel,
        ...units.csvFields(result.distortion),
        elapsedSeconds:(Date.now()-started)/1000
      });
      console.log(`ok (${rows.at(-1).elapsedSeconds.toFixed(1)} s)`);
    } catch (error) {
      rows.push({filename:name,status:'error',error:error.message,elapsedSeconds:(Date.now()-started)/1000});
      console.log(`failed: ${error.message}`);
    }
  }
  const columns=['filename','status','error','qualityStatus','warnings','voltageKv','magnification','resolutionK','width','height','pitchX','pitchY','detected','expected','recovered','minRowCoverage','minColumnCoverage','fitSamples','fitResidualP95Px','meanPx','rmsPx','p95Px','maxPx','affineP95Px','nonlinearP95Px','radialP95Px','tangentialP95Px','rowTiltDeg','columnTiltDeg','includedAngleDeg','orthogonalityErrorDeg','rectifiedPitchPx','nanometersPerPixel','elapsedSeconds'];
  columns.push(...units.csvColumns);
  columns.push('clusterColumnPeriod','clusterRowPeriod');
  const summary=[columns.join(','),...rows.map(row=>columns.map(column=>csv(row[column])).join(','))].join('\n');
  fs.writeFileSync(path.join(outputDirectory,'summary.csv'),`${summary}\n`,'utf8');
  console.log(`Results written to ${outputDirectory}`);
  if(rows.some(row=>row.status==='error')) process.exitCode=1;
})().catch(error => {
  console.error(error);
  process.exitCode=1;
});

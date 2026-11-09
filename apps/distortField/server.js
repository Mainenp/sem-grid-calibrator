const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const sharp = require('sharp');
const imageInputOptions = require('./image-input');
const {inferReference}=require('./cluster-lattice');
const {estimateOrientation,rotationTransform}=require('./grid-orientation');
const {paddingDistance}=require('./scan-support');
const units = require('./public/units');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DEFAULT_IMAGE = process.env.SEM_GRID_IMAGE
  ? path.resolve(process.env.SEM_GRID_IMAGE)
  : path.join(ROOT, 'data', '0.5kv-2000x-4K_07.tif');
let currentImagePath = DEFAULT_IMAGE;
let currentImageFilename = path.basename(DEFAULT_IMAGE);
let currentUploadedImagePath = null;
let latestSquareMaskPng = null;
let latestAnalysisContext = null;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve,reject)=>{
    let body='';
    req.on('data',chunk=>{body+=chunk;if(body.length>1e6) reject(new Error('Request too large'));});
    req.on('end',()=>{try{resolve(body?JSON.parse(body):{});}catch(error){reject(error);}});
    req.on('error',reject);
  });
}

function analysisSummary(result,elapsedSeconds=null) {
  const decomposition=result.distortion.decomposition;
  return {
    source:result.source,
    image:result.image,
    pitch:result.pitch,
    rectification:result.rectification,
    quality:result.quality,
    squareExtraction:{
      detected:result.squareExtraction.detected,
      expected:result.squareExtraction.expected,
      recovered:result.squareExtraction.recovered,
      trimmedTopRows:result.squareExtraction.trimmedTopRows,
      trimmedBottomRows:result.squareExtraction.trimmedBottomRows
    },
    distortion:{
      model:result.distortion.model,
      smoothing:result.distortion.smoothing,
      modelSelection:result.distortion.modelSelection,
      idealPitch:result.distortion.idealPitch,
      referenceLattice:result.distortion.referenceLattice,
      rotationDegrees:result.distortion.rotationDegrees,
      fitSampleCount:result.distortion.fitSampleCount,
      stats:result.distortion.stats,
      fitResidualStats:result.distortion.fitResidualStats,
      physical:result.distortion.physical,
      image:result.distortion.image,
      units:result.distortion.units,
      decomposition:{
        classification:decomposition.classification,
        radialEdgeDisplacement:decomposition.radialEdgeDisplacement,
        coefficients:decomposition.coefficients,
        affine:decomposition.affine,
        stats:decomposition.stats
      }
    },
    elapsedSeconds
  };
}

function resetAnalysisCache() {
  latestSquareMaskPng=null;
  latestAnalysisContext=null;
}

function removeCurrentUpload() {
  if(currentUploadedImagePath) fs.rmSync(currentUploadedImagePath,{force:true});
  currentUploadedImagePath=null;
}

async function useUploadedSource(req,filename) {
  if(!/\.tiff?$/i.test(filename)) throw new Error('Only .tif and .tiff files are supported');
  const temporaryPath=await saveUpload(req,filename);
  try {
    const metadata=await sharp(temporaryPath,imageInputOptions).metadata();
    removeCurrentUpload();
    currentUploadedImagePath=temporaryPath;
    currentImagePath=temporaryPath;
    currentImageFilename=filename;
    resetAnalysisCache();
    return {filename,width:metadata.width,height:metadata.height};
  } catch(error) {
    fs.rmSync(temporaryPath,{force:true});
    throw error;
  }
}

function useDefaultSource() {
  removeCurrentUpload();
  currentImagePath=DEFAULT_IMAGE;
  currentImageFilename=path.basename(DEFAULT_IMAGE);
  resetAnalysisCache();
}

async function saveUpload(req,filename) {
  const extension=/\.tiff?$/i.test(filename)?path.extname(filename):'.tif';
  const uploadDirectory=path.join(os.tmpdir(),'sem-grid-calibrator-uploads');
  fs.mkdirSync(uploadDirectory,{recursive:true});
  const temporaryPath=path.join(uploadDirectory,`${crypto.randomUUID()}${extension}`);
  try {
    await pipeline(req,fs.createWriteStream(temporaryPath,{flags:'wx'}));
    return temporaryPath;
  } catch(error) {
    fs.rmSync(temporaryPath,{force:true});
    throw error;
  }
}

function smooth(values, radius) {
  const out = new Float64Array(values.length);
  let sum = 0;
  for (let i = -radius; i < values.length + radius; i++) {
    const add = i + radius;
    const remove = i - radius - 1;
    if (add >= 0 && add < values.length) sum += values[add];
    if (remove >= 0 && remove < values.length) sum -= values[remove];
    if (i >= 0 && i < values.length) {
      const lo = Math.max(0, i - radius);
      const hi = Math.min(values.length - 1, i + radius);
      out[i] = sum / (hi - lo + 1);
    }
  }
  return out;
}

function acquisitionFromFilename(filename, width) {
  const match = path.basename(filename).match(/^(\d+(?:\.\d+)?)kv-(\d+)(k?)x-(\d+)K_/i);
  if (!match) return { voltageKv:null, magnification:null, resolutionK:null, fovMicrometers:63.5, expectedPitch:null };
  const voltageKv = Number(match[1]);
  const magnification = Number(match[2]) * (match[3] ? 1000 : 1);
  const resolutionK = Number(match[4]);
  // The supplied calibration series uses an approximately 1 µm square-grid
  // pitch and FOV*magnification ~= 127000 µm. This is a soft search prior only;
  // the measured autocorrelation peak remains the reported pitch.
  const fovMicrometers = 127000 / magnification;
  return {
    voltageKv, magnification, resolutionK, fovMicrometers,
    expectedPitch:width / fovMicrometers
  };
}

function estimatePitch(profile, expectedPitch=null) {
  const n = profile.length;
  const broadRadius = expectedPitch
    ? Math.max(3, Math.round(expectedPitch * 1.4))
    : Math.max(8, Math.round(n / 90));
  const broad = smooth(profile, broadRadius);
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = profile[i] - broad[i];
  const minLag = expectedPitch
    ? Math.max(3, Math.floor(expectedPitch * .65))
    : Math.max(8, Math.round(n / 110));
  const maxLag = expectedPitch
    ? Math.min(Math.floor(n / 4), Math.ceil(expectedPitch * 1.35))
    : Math.min(Math.round(n / 18), 90);
  if (maxLag < minLag) throw new Error('Grid pitch search range is empty');
  const scores = [];
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = lag; i < n; i++) score += signal[i] * signal[i - lag];
    score /= n - lag;
    scores.push({ lag, score });
    if (score > bestScore) bestScore = score;
  }
  // Repeating grids also produce strong peaks at 2x, 3x, ... the true pitch.
  // Select the earliest clear local peak that is reasonably close to the
  // strongest response, rather than blindly choosing a harmonic.
  // A black/support edge can create a monotonically decaying response whose
  // maximum is the search boundary. It is not a resolved periodic peak.
  const peaks=scores.filter((item,i)=>i>0&&i+1<scores.length&&
    item.score>=scores[i-1].score&&item.score>=scores[i+1].score);
  const peakMaximum=peaks.reduce((v,p)=>Math.max(v,p.score),-Infinity);
  const candidates=peaks.filter(p=>p.score>=peakMaximum*.58);
  const selected=expectedPitch&&candidates.length
    ? candidates.reduce((a,b)=>Math.abs(a.lag-expectedPitch)<Math.abs(b.lag-expectedPitch)?a:b)
    : candidates.length?candidates[0]:scores.reduce((a,b)=>a.score>b.score?a:b);
  const index=scores.indexOf(selected);
  if(index>0&&index+1<scores.length) {
    const left=scores[index-1].score,center=selected.score,right=scores[index+1].score;
    const denominator=left-2*center+right;
    if(Math.abs(denominator)>1e-12) {
      const offset=Math.max(-.5,Math.min(.5,.5*(left-right)/denominator));
      return selected.lag+offset;
    }
  }
  return selected.lag;
}

function findPeriodicCenters(profile, expectedPitch=null,counts=null) {
  if(counts){
    const maximum=counts.reduce((a,b)=>Math.max(a,b),0);
    let left=0,right=counts.length-1;
    while(left<right&&counts[left]<maximum*.5)left++;
    while(right>left&&counts[right]<maximum*.5)right--;
    if(right-left+1>=Math.max(24,(expectedPitch||8)*3)){
      const found=findPeriodicCenters(profile.slice(left,right+1),expectedPitch);
      return {...found,positions:found.positions.map(p=>p+left)};
    }
  }
  const filtered = smooth(profile, 1);
  const pitch = estimatePitch(filtered, expectedPitch);
  let phase = 0;
  let best = -Infinity;
  for (let p = 0; p < pitch; p++) {
    let score = 0;
    let count = 0;
    for (let x = p; x < filtered.length; x += pitch) {
      if (x > pitch * 0.35 && x < filtered.length - pitch * 0.35) {
        score += filtered[Math.round(x)]; count++;
      }
    }
    score /= Math.max(1, count);
    if (score > best) { best = score; phase = p; }
  }

  const positions = [];
  const edgeMargin = Math.max(1, Math.round(pitch * 0.12));
  let start = phase;
  while (start - pitch >= 0) start -= pitch;
  for (let expected = start; expected < filtered.length; expected += pitch) {
    const at = Math.round(expected);
    // Preserve one seed per lattice interval. Refining each seed to a local
    // maximum here can make adjacent rows collapse onto one damaged square,
    // which silently drops a line. Pixel-based refinement happens later.
    if (at >= edgeMargin && at < filtered.length - edgeMargin) positions.push(at);
  }
  return { pitch, positions };
}

function linearFit(points) {
  let active = points.slice();
  for (let pass = 0; pass < 3 && active.length >= 4; pass++) {
    const mx = active.reduce((s, p) => s + p[0], 0) / active.length;
    const my = active.reduce((s, p) => s + p[1], 0) / active.length;
    let cov = 0, variance = 0;
    for (const [x, y] of active) { cov += (x - mx) * (y - my); variance += (x - mx) ** 2; }
    const slope = variance ? cov / variance : 0;
    const intercept = my - slope * mx;
    const residuals = active.map(p => Math.abs(p[1] - (slope * p[0] + intercept))).sort((a, b) => a - b);
    const median = residuals[Math.floor(residuals.length / 2)] || 0;
    const limit = Math.max(1.5, median * 3.5);
    const kept = active.filter(p => Math.abs(p[1] - (slope * p[0] + intercept)) <= limit);
    if (kept.length === active.length) return { slope, intercept, samples: active.length, error: median };
    active = kept;
  }
  const mx = active.reduce((s, p) => s + p[0], 0) / active.length;
  const my = active.reduce((s, p) => s + p[1], 0) / active.length;
  let cov = 0, variance = 0;
  for (const [x, y] of active) { cov += (x - mx) * (y - my); variance += (x - mx) ** 2; }
  const slope = variance ? cov / variance : 0;
  return { slope, intercept: my - slope * mx, samples: active.length, error: 0 };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustStraightFit(points) {
  // Theil-Sen initialization is resistant to square centers accidentally
  // matched to an adjacent row/column. Follow it with least squares using
  // only geometrically consistent centers.
  const slopes = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j][0] - points[i][0];
      if (Math.abs(dx) > 4) slopes.push((points[j][1] - points[i][1]) / dx);
    }
  }
  let slope = median(slopes);
  let intercept = median(points.map(([x, y]) => y - slope * x));
  let active = points.slice();
  for (let pass = 0; pass < 3; pass++) {
    const residuals = active.map(([x, y]) => Math.abs(y - (slope * x + intercept)));
    const mad = median(residuals);
    const limit = Math.max(1.25, mad * 3.5);
    const kept = points.filter(([x, y]) => Math.abs(y - (slope * x + intercept)) <= limit);
    if (kept.length < Math.max(6, points.length * 0.45)) break;
    active = kept;
    const mx = active.reduce((sum, p) => sum + p[0], 0) / active.length;
    const my = active.reduce((sum, p) => sum + p[1], 0) / active.length;
    let covariance = 0, variance = 0;
    for (const [x, y] of active) { covariance += (x - mx) * (y - my); variance += (x - mx) ** 2; }
    slope = variance ? covariance / variance : 0;
    intercept = my - slope * mx;
  }
  return { slope, intercept, samples:active.length, totalSamples:points.length };
}

function solveSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col] || 1e-12;
    for (let j = col; j <= n; j++) a[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map(row => row[n]);
}

function fitGridRectification(centers,inv,reference=null) {
  const samples=centers.filter(point=>point.usedForFit!==false);
  const col=p=>reference?reference.column.coordinates[p.column]:p.column;
  const rowAt=p=>reference?reference.row.coordinates[p.row]:p.row;
  if(samples.length<10) return null;
  const meanColumn=samples.reduce((sum,p)=>sum+col(p),0)/samples.length;
  const meanRow=samples.reduce((sum,p)=>sum+rowAt(p),0)/samples.length;
  const baseWeights=samples.map(p=>Math.max(.05,Math.min(1,p.confidence??1)));
  let weights=baseWeights.slice(),x=[0,0,0],y=[0,0,0];
  for(let pass=0;pass<4;pass++) {
    const normal=Array.from({length:3},()=>[0,0,0]);
    const rightX=[0,0,0],rightY=[0,0,0];
    for(let index=0;index<samples.length;index++) {
      const p=samples[index],terms=[1,col(p)-meanColumn,rowAt(p)-meanRow],weight=weights[index];
      for(let i=0;i<3;i++) {
        rightX[i]+=weight*terms[i]*p.x;rightY[i]+=weight*terms[i]*p.y;
        for(let j=0;j<3;j++) normal[i][j]+=weight*terms[i]*terms[j];
      }
    }
    x=solveSystem(normal,rightX);y=solveSystem(normal,rightY);
    if(pass===3) break;
    const residuals=samples.map(p=>{
      const column=col(p)-meanColumn,row=rowAt(p)-meanRow;
      return Math.hypot(p.x-x[0]-x[1]*column-x[2]*row,p.y-y[0]-y[1]*column-y[2]*row);
    });
    const center=median(residuals);
    const sigma=1.4826*median(residuals.map(value=>Math.abs(value-center)));
    const limit=Math.max(.5,center+2.5*sigma);
    weights=residuals.map((value,index)=>baseWeights[index]*Math.min(1,limit/Math.max(value,1e-9)));
  }
  const column={x:x[1]*inv,y:y[1]*inv},row={x:x[2]*inv,y:y[2]*inv};
  const columnPitch=Math.hypot(column.x,column.y),rowPitch=Math.hypot(row.x,row.y);
  const determinant=column.x*row.y-column.y*row.x;
  if(!Number.isFinite(determinant)||determinant<=0||columnPitch<1||rowPitch<1) return null;
  const targetPitch=Math.sqrt(determinant);
  const matrix=[
    [targetPitch*row.y/determinant,-targetPitch*row.x/determinant],
    [-targetPitch*column.y/determinant,targetPitch*column.x/determinant]
  ];
  const toDegrees=180/Math.PI;
  const rowTiltDegrees=Math.atan2(column.y,column.x)*toDegrees;
  const columnTiltDegrees=Math.atan2(row.x,row.y)*toDegrees;
  const includedAngleDegrees=Math.acos(Math.max(-1,Math.min(1,
    (column.x*row.x+column.y*row.y)/(columnPitch*rowPitch)
  )))*toDegrees;
  return {
    rowTiltDegrees,columnTiltDegrees,includedAngleDegrees,
    orthogonalityErrorDegrees:includedAngleDegrees-90,
    columnPitchPx:columnPitch,rowPitchPx:rowPitch,targetPitchPx:targetPitch,
    correctionMatrix:matrix,
    fittedCenter:{x:x[0]*inv,y:y[0]*inv},
    sampleCount:samples.length,
    method:'robust affine fit; area-preserving square rectification'
  };
}

function rectifiedImagePipeline(imagePath,rectification,specimenSize) {
  if(!rectification) throw new Error('Grid geometry is unavailable for rectification');
  return sharp(imagePath,imageInputOptions)
    .extract({left:0,top:0,width:specimenSize,height:specimenSize})
    .affine(rectification.correctionMatrix,{
      background:'#000000',interpolator:sharp.interpolators.bicubic
    })
    .png();
}

function polynomialFit(points, degree = 3) {
  let active = points.slice();
  const origin = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const scale = points.reduce((maximum,p)=>Math.max(maximum,Math.abs(p[0]-origin)),1);
  let coefficients = [];
  for (let pass = 0; pass < 3; pass++) {
    const size = degree + 1;
    const matrix = Array.from({ length:size }, () => Array(size).fill(0));
    const vector = Array(size).fill(0);
    for (const [x, y] of active) {
      const t = (x - origin) / scale;
      const powers = Array.from({ length:degree * 2 + 1 }, (_, i) => t ** i);
      for (let r = 0; r < size; r++) {
        vector[r] += y * powers[r];
        for (let c = 0; c < size; c++) matrix[r][c] += powers[r + c];
      }
    }
    coefficients = solveSystem(matrix, vector);
    const residuals = active.map(p => Math.abs(p[1] - evaluatePolynomial({ coefficients, origin, scale }, p[0]))).sort((a,b) => a-b);
    const median = residuals[Math.floor(residuals.length / 2)] || 0;
    const limit = Math.max(1.5, median * 3.5);
    const kept = active.filter(p => Math.abs(p[1] - evaluatePolynomial({ coefficients, origin, scale }, p[0])) <= limit);
    if (kept.length === active.length || kept.length < degree + 2) break;
    active = kept;
  }
  return { coefficients, origin, scale, samples:active.length };
}

function evaluatePolynomial(model, x) {
  const t = (x - model.origin) / model.scale;
  return model.coefficients.reduce((sum, value, power) => sum + value * t ** power, 0);
}

function regularizeSlopes(lines, extent) {
  // Grid orientation changes smoothly under SEM distortion. Independent fits
  // can occasionally lock onto a defect or the adjacent gap and produce an
  // implausible tilt. Smooth orientation locally while preserving the fitted
  // position at the center of the image.
  return lines.map((line, index) => {
    const neighborhood = lines
      .slice(Math.max(0, index - 3), Math.min(lines.length, index + 4))
      .map(item => item.slope)
      .sort((a, b) => a - b);
    const localMedian = neighborhood[Math.floor(neighborhood.length / 2)];
    const centerPosition = line.slope * (extent / 2) + line.intercept;
    const difference = Math.abs(line.slope - localMedian);
    const ownWeight = difference > 0.002 ? 0 : 0.25;
    const slope = ownWeight * line.slope + (1 - ownWeight) * localMedian;
    return { ...line, slope, intercept: centerPosition - slope * (extent / 2) };
  });
}

function fitVertical(data, width, height, x0, pitch, rowCenters, rowPitch) {
  const points = [];
  const halfBand = Math.max(2, Math.round(rowPitch * 0.24));
  for (const y of rowCenters) {
    if (y < halfBand || y >= height - halfBand) continue;
    const profile = x => {
      let sum = 0;
      for (let yy = y - halfBand; yy <= y + halfBand; yy++) sum += data[yy * width + x];
      return sum;
    };
    let left = null, right = null;
    for (let x = Math.max(0, Math.round(x0 - pitch * .65)); x <= Math.min(width - 1, Math.round(x0 - pitch * .2)); x++) {
      const value = profile(x);
      if (!left || value < left.value) left = { at:x, value };
    }
    for (let x = Math.max(0, Math.round(x0 + pitch * .2)); x <= Math.min(width - 1, Math.round(x0 + pitch * .65)); x++) {
      const value = profile(x);
      if (!right || value < right.value) right = { at:x, value };
    }
    if (left && right) points.push([y, (left.at + right.at) / 2]);
  }
  const initial = robustStraightFit(points);
  let best = initial, bestScore = -Infinity;
  const sampleHalf = Math.max(1, Math.round(rowPitch * .16));
  for (let tiltStep = -3; tiltStep <= 3; tiltStep++) {
    const slope = initial.slope + tiltStep * (pitch * .025 / height);
    for (let offsetStep = -4; offsetStep <= 4; offsetStep++) {
      const offset = offsetStep * pitch * .025;
      const intercept = initial.intercept + offset - (slope - initial.slope) * height / 2;
      let score = 0, count = 0;
      for (const y of rowCenters) {
        const center = Math.round(slope * y + intercept);
        const left = Math.round(center - pitch * .48), right = Math.round(center + pitch * .48);
        if (left < 0 || right >= width || y < sampleHalf || y >= height - sampleHalf) continue;
        for (let yy = y - sampleHalf; yy <= y + sampleHalf; yy++) {
          score += 2 * data[yy * width + center] - data[yy * width + left] - data[yy * width + right];
          count++;
        }
      }
      if (count && score / count > bestScore) { bestScore = score / count; best = { ...initial, slope, intercept }; }
    }
  }
  return { ...best, measurements:points.map(([y, x]) => ({ y, x })) }; // x = slope*y + intercept
}

function fitHorizontal(data, width, height, y0, pitch, columnCenters, columnPitch) {
  const points = [];
  const halfBand = Math.max(2, Math.round(columnPitch * 0.24));
  for (const x of columnCenters) {
    if (x < halfBand || x >= width - halfBand) continue;
    const profile = y => {
      let sum = 0;
      for (let xx = x - halfBand; xx <= x + halfBand; xx++) sum += data[y * width + xx];
      return sum;
    };
    let top = null, bottom = null;
    for (let y = Math.max(0, Math.round(y0 - pitch * .65)); y <= Math.min(height - 1, Math.round(y0 - pitch * .2)); y++) {
      const value = profile(y);
      if (!top || value < top.value) top = { at:y, value };
    }
    for (let y = Math.max(0, Math.round(y0 + pitch * .2)); y <= Math.min(height - 1, Math.round(y0 + pitch * .65)); y++) {
      const value = profile(y);
      if (!bottom || value < bottom.value) bottom = { at:y, value };
    }
    if (top && bottom) points.push([x, (top.at + bottom.at) / 2]);
  }
  const initial = robustStraightFit(points);
  let best = initial, bestScore = -Infinity;
  const sampleHalf = Math.max(1, Math.round(columnPitch * .16));
  for (let tiltStep = -3; tiltStep <= 3; tiltStep++) {
    const slope = initial.slope + tiltStep * (pitch * .025 / width);
    for (let offsetStep = -4; offsetStep <= 4; offsetStep++) {
      const offset = offsetStep * pitch * .025;
      const intercept = initial.intercept + offset - (slope - initial.slope) * width / 2;
      let score = 0, count = 0;
      for (const x of columnCenters) {
        const center = Math.round(slope * x + intercept);
        const top = Math.round(center - pitch * .48), bottom = Math.round(center + pitch * .48);
        if (top < 0 || bottom >= height || x < sampleHalf || x >= width - sampleHalf) continue;
        for (let xx = x - sampleHalf; xx <= x + sampleHalf; xx++) {
          score += 2 * data[center * width + xx] - data[top * width + xx] - data[bottom * width + xx];
          count++;
        }
      }
      if (count && score / count > bestScore) { bestScore = score / count; best = { ...initial, slope, intercept }; }
    }
  }
  return { ...best, measurements:points.map(([x, y]) => ({ x, y })) }; // y = slope*x + intercept
}

function computeDistortion(vertical, horizontal, columnSeeds, rowSeeds, inv, exclusions={}) {
  const excludedRows=new Set(exclusions.rows||[]),excludedColumns=new Set(exclusions.columns||[]);
  const samples = [];
  for (let row = 0; row < rowSeeds.length; row++) {
    for (let column = 0; column < columnSeeds.length; column++) {
      if(excludedRows.has(row)||excludedColumns.has(column)) continue;
      const vx = vertical[column].measurements.find(p => p.y === rowSeeds[row]);
      const hy = horizontal[row].measurements.find(p => p.x === columnSeeds[column]);
      if (vx && hy) samples.push({ column, row, x:vx.x, y:hy.y, confidence:Math.min(vx.confidence??1,hy.confidence??1) });
    }
  }
  if(samples.length<10) throw new Error('Too few reliable square centers for distortion fitting');
  const referenceLattice=inferReference(samples,columnSeeds.length,rowSeeds.length);
  if(exclusions.clusterCorrection===false)for(const [axis,count] of [['column',columnSeeds.length],['row',rowSeeds.length]]) {
    referenceLattice[axis]={status:'disabled',period:null,coordinates:Array.from({length:count},(_,i)=>i)};
  }
  const col=p=>referenceLattice.column.coordinates[p.column],rowAt=p=>referenceLattice.row.coordinates[p.row];
  const totalWeight=samples.reduce((sum,p)=>sum+p.confidence,0);
  const meanColumn=samples.reduce((s,p)=>s+p.confidence*col(p),0)/totalWeight;
  const meanRow=samples.reduce((s,p)=>s+p.confidence*rowAt(p),0)/totalWeight;
  const meanX=samples.reduce((s,p)=>s+p.confidence*p.x,0)/totalWeight;
  const meanY=samples.reduce((s,p)=>s+p.confidence*p.y,0)/totalWeight;
  let denominator = 0, cNumerator = 0, dNumerator = 0;
  for (const p of samples) {
    const u = col(p) - meanColumn, v = rowAt(p) - meanRow;
    const x = p.x - meanX, y = p.y - meanY;
    denominator += p.confidence*(u*u+v*v);
    cNumerator += p.confidence*(u*x+v*y);
    dNumerator += p.confidence*(u*y-v*x);
  }
  const c = cNumerator / denominator;
  const d = dNumerator / denominator;
  const measured = samples.map(p => {
    const u = col(p) - meanColumn, v = rowAt(p) - meanRow;
    const idealX = meanX + c*u - d*v;
    const idealY = meanY + d*u + c*v;
    const dx = (p.x - idealX) * inv, dy = (p.y - idealY) * inv;
    return {
      column:p.column, row:p.row,
      x:p.x * inv, y:p.y * inv,
      idealX:idealX * inv, idealY:idealY * inv,
      dx, dy, magnitude:Math.hypot(dx, dy), confidence:p.confidence
    };
  });
  const smooth = fitSmoothVectorField(measured, columnSeeds.length, rowSeeds.length);
  const fittedSamples = measured.map(p => {
    const vector = evaluateSmoothVectorField(smooth, p.column, p.row);
    return {
      ...p, rawDx:p.dx, rawDy:p.dy,
      dx:vector.dx, dy:vector.dy, magnitude:Math.hypot(vector.dx, vector.dy),
      fitResidualDx:p.dx-vector.dx, fitResidualDy:p.dy-vector.dy
    };
  });
  const fitResidualStats=vectorStats(fittedSamples,'fitResidualDx','fitResidualDy');
  const enriched=[];
  for(let row=0;row<rowSeeds.length;row++) for(let column=0;column<columnSeeds.length;column++) {
    const u=referenceLattice.column.coordinates[column]-meanColumn,v=referenceLattice.row.coordinates[row]-meanRow;
    const idealX=meanX+c*u-d*v,idealY=meanY+d*u+c*v;
    const vector=evaluateSmoothVectorField(smooth,column,row);
    enriched.push({column,row,x:(idealX+vector.dx/inv)*inv,y:(idealY+vector.dy/inv)*inv,idealX:idealX*inv,idealY:idealY*inv,dx:vector.dx,dy:vector.dy,magnitude:Math.hypot(vector.dx,vector.dy),excluded:excludedRows.has(row)||excludedColumns.has(column)});
  }
  const magnitudes = enriched.map(p => p.magnitude).sort((a,b) => a-b);
  const mean = magnitudes.reduce((s,v) => s+v, 0) / magnitudes.length;
  const rms = Math.sqrt(magnitudes.reduce((s,v) => s+v*v, 0) / magnitudes.length);
  const percentile = q => magnitudes[Math.min(magnitudes.length - 1, Math.floor(q * (magnitudes.length - 1)))];
  const maximum = enriched.reduce((a,b) => a.magnitude > b.magnitude ? a : b);
  const decomposition=decomposeStandardDistortion(enriched.filter(p=>!p.excluded),enriched);
  const fitSupport=measured.reduce((b,p)=>({minimumColumn:Math.min(b.minimumColumn,p.column),maximumColumn:Math.max(b.maximumColumn,p.column),
    minimumRow:Math.min(b.minimumRow,p.row),maximumRow:Math.max(b.maximumRow,p.row)}),{minimumColumn:Infinity,maximumColumn:-Infinity,minimumRow:Infinity,maximumRow:-Infinity});
  const result={
    model:'best-fit square similarity lattice with replicated specimen spacing',
    referenceLattice,
    smoothing:`robust degree-${smooth.degree||3} 2D polynomial`,
    modelSelection:smooth.selection,
    idealPitch:Math.hypot(c,d) * inv,
    rotationDegrees:Math.atan2(d,c) * 180 / Math.PI,
    stats:{ min:magnitudes[0], mean, rms, p95:percentile(.95), max:maximum.magnitude },
    maximum:{ x:maximum.x, y:maximum.y, dx:maximum.dx, dy:maximum.dy },
    rows:rowSeeds.length, columns:columnSeeds.length,
    fitSampleCount:fittedSamples.length,
    fitResidualStats,
    measuredStats:vectorStats(measured,'dx','dy'),
    compensationModel:{smooth,fitSupport,lattice:{meanColumn,meanRow,centerX:meanX*inv,centerY:meanY*inv,c:c*inv,d:d*inv,
      columnCoordinates:referenceLattice.column.coordinates,rowCoordinates:referenceLattice.row.coordinates}},
    excluded:{rows:[...excludedRows],columns:[...excludedColumns]},
    decomposition,
    samples:enriched
  };
  // Backend-only measured centers support a fixed-target, matched-cohort
  // validation without duplicating tens of thousands of points in API JSON.
  Object.defineProperty(result,'measuredSamples',{value:measured,enumerable:false});
  return result;
}

const {surfaceTerms,evaluateField}=require('./field-basis');

function fitSurface(samples, values, columnCount, rowCount, degree=3) {
  const size = (degree+1)*(degree+2)/2;
  const items = samples.map((sample,index)=>({sample,value:values[index],baseWeight:sample.confidence??1,weight:sample.confidence??1}));
  let coefficients = Array(size).fill(0);
  // Iteratively reweighted least squares keeps every valid sample while
  // smoothly reducing the influence of a damaged or poorly segmented square.
  // This avoids the discontinuities caused by repeatedly dropping samples at
  // a hard residual threshold.
  for (let pass = 0; pass < 6; pass++) {
    const matrix = Array.from({length:size}, () => Array(size).fill(0));
    const vector = Array(size).fill(0);
    for (const item of items) {
      const terms = surfaceTerms(item.sample.column, item.sample.row, columnCount, rowCount, degree);
      for (let r=0;r<size;r++) {
        vector[r] += item.weight * terms[r] * item.value;
        for (let c=0;c<size;c++) matrix[r][c] += item.weight * terms[r] * terms[c];
      }
    }
    const averageDiagonal = matrix.reduce((sum,row,index)=>sum+row[index],0) / size;
    for(let i=0;i<size;i++) matrix[i][i] += averageDiagonal * 1e-10;
    coefficients = solveSystem(matrix, vector);
    const residuals = items.map(item => {
      const terms = surfaceTerms(item.sample.column, item.sample.row, columnCount, rowCount, degree);
      const predicted = coefficients.reduce((sum, value, i) => sum + value * terms[i], 0);
      return item.value - predicted;
    });
    const residualCenter = median(residuals);
    const sigma = 1.4826 * median(residuals.map(value => Math.abs(value - residualCenter)));
    const limit = Math.max(.2, sigma * 1.5);
    let change = 0;
    for(let i=0;i<items.length;i++) {
      const normalized = Math.abs(residuals[i] - residualCenter);
      const robustWeight=normalized<=limit?1:limit/normalized;
      const weight=items[i].baseWeight*robustWeight;
      change = Math.max(change, Math.abs(weight - items[i].weight));
      items[i].weight = weight;
    }
    if(change < 1e-3) break;
  }
  return coefficients;
}

function fitSmoothVectorField(samples, columnCount, rowCount) {
  const fit=(points,degree)=>({columnCount,rowCount,degree,
    dx:fitSurface(points,points.map(p=>p.dx),columnCount,rowCount,degree),
    dy:fitSurface(points,points.map(p=>p.dy),columnCount,rowCount,degree)});
  const base=fit(samples,3);
  // Three interleaved, deterministic folds cover the full measured domain.
  // Model complexity is selected on points absent from each corresponding
  // fit. This diagnoses field interpolation, not independent SEM accuracy.
  const cols=new Set(samples.map(p=>p.column)),rows=new Set(samples.map(p=>p.row));
  if(samples.length<126||cols.size<8||rows.size<8){
    base.selection={method:'spatial three-fold prediction',selectedDegree:3,reason:'insufficient support for a 21-term candidate'};return base;
  }
  const results=[];
  for(let fold=0;fold<3;fold++){
    const train=samples.filter(p=>(p.column+2*p.row)%3!==fold),test=samples.filter(p=>(p.column+2*p.row)%3===fold);
    if(train.length<84||test.length<20){base.selection={selectedDegree:3,reason:'insufficient fold support'};return base;}
    const item={fold,training:train.length,validation:test.length};
    for(const degree of [3,5]){const f=fit(train,degree),error=test.map(p=>{const q=evaluateField(f,p.column,p.row);return Math.hypot(q.dx-p.dx,q.dy-p.dy);}).sort((a,b)=>a-b);item[degree]=error[Math.floor((error.length-1)*.95)];}
    results.push(item);
  }
  const cubic=results.reduce((s,r)=>s+r[3],0)/3,quintic=results.reduce((s,r)=>s+r[5],0)/3;
  const useHigher=cubic-quintic>.15&&quintic<cubic*.65&&results.every(r=>r[5]<r[3]*.9);
  const selected=useHigher?fit(samples,5):base;
  selected.selection={method:'spatial three-fold prediction',selectedDegree:useHigher?5:3,
    cubicValidationP95:cubic,quinticValidationP95:quintic,folds:results,
    reason:useHigher?'quintic improves every held-out fold and exceeds relative/absolute gain thresholds':'higher order lacks consistent held-out improvement',
    limitation:'Field prediction within this image; not an independent physical calibration'};
  return selected;
}

function evaluateSmoothVectorField(field, column, row) {
  return evaluateField(field,column,row);
}

function vectorStats(samples, dxKey, dyKey) {
  const values=samples.map(p=>Math.hypot(p[dxKey],p[dyKey])).sort((a,b)=>a-b);
  return {mean:values.reduce((s,v)=>s+v,0)/values.length,rms:Math.sqrt(values.reduce((s,v)=>s+v*v,0)/values.length),p95:values[Math.floor((values.length-1)*.95)],max:values.at(-1)};
}

function scalarStats(values) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length) return {mean:null,rms:null,p95:null,max:null};
  return {
    mean:sorted.reduce((sum,value)=>sum+value,0)/sorted.length,
    rms:Math.sqrt(sorted.reduce((sum,value)=>sum+value*value,0)/sorted.length),
    p95:sorted[Math.floor((sorted.length-1)*.95)],
    max:sorted.at(-1)
  };
}

function decomposeStandardDistortion(samples,displaySamples=samples) {
  const bounds=samples.reduce((b,p)=>({minX:Math.min(b.minX,p.idealX),maxX:Math.max(b.maxX,p.idealX),
    minY:Math.min(b.minY,p.idealY),maxY:Math.max(b.maxY,p.idealY)}),{minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity});
  const {minX,maxX,minY,maxY}=bounds;
  const centerX=(minX+maxX)/2,centerY=(minY+maxY)/2,radius=Math.hypot((maxX-minX)/2,(maxY-minY)/2);
  const size=9,matrix=Array.from({length:size},()=>Array(size).fill(0)),vector=Array(size).fill(0);
  const add=(row,value)=>{for(let r=0;r<size;r++){vector[r]+=row[r]*value;for(let c=0;c<size;c++)matrix[r][c]+=row[r]*row[c];}};
  for(const p of samples){const x=(p.idealX-centerX)/radius,y=(p.idealY-centerY)/radius,r2=x*x+y*y,r4=r2*r2,r6=r4*r2;add([x,y,0,0,x*r2,x*r4,x*r6,2*x*y,r2+2*x*x],p.dx/radius);add([0,0,x,y,y*r2,y*r4,y*r6,r2+2*y*y,2*x*y],p.dy/radius);}
  const [a11,a12,a21,a22,k1,k2,k3,p1,p2]=solveSystem(matrix,vector);
  for(const p of displaySamples){const x=(p.idealX-centerX)/radius,y=(p.idealY-centerY)/radius,r2=x*x+y*y,r4=r2*r2,r6=r4*r2,radial=k1*r2+k2*r4+k3*r6;p.affineDx=radius*(a11*x+a12*y);p.affineDy=radius*(a21*x+a22*y);p.radialDx=radius*x*radial;p.radialDy=radius*y*radial;p.tangentialDx=radius*(2*p1*x*y+p2*(r2+2*x*x));p.tangentialDy=radius*(p1*(r2+2*y*y)+2*p2*x*y);p.residualDx=p.dx-p.affineDx-p.radialDx-p.tangentialDx;p.residualDy=p.dy-p.affineDy-p.radialDy-p.tangentialDy;p.nonlinearDx=p.dx-p.affineDx;p.nonlinearDy=p.dy-p.affineDy;}
  const edgeScale=k1+k2+k3;
  return {center:{x:centerX,y:centerY},normalizationRadius:radius,classification:Math.abs(edgeScale)<1e-5?'negligible':edgeScale<0?'barrel':'pincushion',radialEdgeDisplacement:edgeScale*radius,coefficients:{normalized:{k1,k2,k3,p1,p2,a11,a12,a21,a22},pixelDomain:{k1:k1/radius**2,k2:k2/radius**4,k3:k3/radius**6,p1:p1/radius,p2:p2/radius}},affine:{uniformScale:(a11+a22)/2,differentialScale:(a11-a22)/2,shear:(a12+a21)/2,rotationLike:(a21-a12)/2},stats:{nonlinear:vectorStats(displaySamples,'nonlinearDx','nonlinearDy'),radial:vectorStats(displaySamples,'radialDx','radialDy'),tangential:vectorStats(displaySamples,'tangentialDx','tangentialDy'),affine:vectorStats(displaySamples,'affineDx','affineDy'),residual:vectorStats(displaySamples,'residualDx','residualDy')}};
}

function otsuThreshold(histogram, total) {
  let weightedTotal = 0;
  for (let i=0;i<256;i++) weightedTotal += i * histogram[i];
  let backgroundWeight = 0, backgroundSum = 0, bestVariance = -1, threshold = 128;
  for (let i=0;i<256;i++) {
    backgroundWeight += histogram[i];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += i * histogram[i];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (weightedTotal - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) { bestVariance = variance; threshold = i; }
  }
  return threshold;
}

function extractSquareCenters(data, width, height, columnSeeds, rowSeeds, pitchX, pitchY, wantedCells=null, seedPredictor=null) {
  const squares = [];
  const acceptedMask = new Uint8Array(width * height);
  const searchFactor=wantedCells?.size ? .65 : .46;
  const maximumSeedDistance=wantedCells?.size ? .48 : .32;
  const radiusX = Math.max(4, Math.round(pitchX * searchFactor));
  const radiusY = Math.max(4, Math.round(pitchY * searchFactor));
  for (let row=0;row<rowSeeds.length;row++) {
    for (let column=0;column<columnSeeds.length;column++) {
      if(wantedCells&&!wantedCells.has(`${column},${row}`)) continue;
      const predicted=seedPredictor?seedPredictor(column,row):null;
      const seedX=predicted?.x??columnSeeds[column], seedY=predicted?.y??rowSeeds[row];
      const left=Math.max(0,seedX-radiusX), right=Math.min(width-1,seedX+radiusX);
      const top=Math.max(0,seedY-radiusY), bottom=Math.min(height-1,seedY+radiusY);
      const patchWidth=right-left+1, patchHeight=bottom-top+1, total=patchWidth*patchHeight;
      const histogram=new Uint32Array(256);
      for(let y=top;y<=bottom;y++) for(let x=left;x<=right;x++) histogram[data[y*width+x]]++;
      const localContrast=histogramPercentile(histogram,.9)-histogramPercentile(histogram,.1);
      if(localContrast<4) continue;
      const threshold=otsuThreshold(histogram,total);
      const mask=new Uint8Array(total);
      for(let py=0;py<patchHeight;py++) for(let px=0;px<patchWidth;px++) {
        const value=data[(top+py)*width+left+px];
        if(value<=threshold) continue;
        let neighbors=0;
        if(px>0 && data[(top+py)*width+left+px-1]>threshold) neighbors++;
        if(px+1<patchWidth && data[(top+py)*width+left+px+1]>threshold) neighbors++;
        if(py>0 && data[(top+py-1)*width+left+px]>threshold) neighbors++;
        if(py+1<patchHeight && data[(top+py+1)*width+left+px]>threshold) neighbors++;
        if(neighbors>=2) mask[py*patchWidth+px]=1;
      }
      let best=null;
      const queue=new Int32Array(total);
      for(let start=0;start<total;start++) {
        if(mask[start]!==1) continue;
        let head=0,tail=0; queue[tail++]=start; mask[start]=2;
        let area=0,sumX=0,sumY=0,minX=patchWidth,maxX=0,minY=patchHeight,maxY=0;
        const component=[];
        while(head<tail) {
          const index=queue[head++], px=index%patchWidth, py=Math.floor(index/patchWidth);
          component.push(index);
          area++; sumX+=px; sumY+=py; minX=Math.min(minX,px); maxX=Math.max(maxX,px); minY=Math.min(minY,py); maxY=Math.max(maxY,py);
          const neighbors=[index-1,index+1,index-patchWidth,index+patchWidth];
          for(const next of neighbors) {
            if(next<0||next>=total||mask[next]!==1) continue;
            const nx=next%patchWidth;
            if(Math.abs(nx-px)>1) continue;
            mask[next]=2; queue[tail++]=next;
          }
        }
        const cx=left+sumX/area, cy=top+sumY/area;
        const distance=Math.hypot((cx-seedX)/pitchX,(cy-seedY)/pitchY);
        const boxArea=(maxX-minX+1)*(maxY-minY+1);
        const fill=area/boxArea;
        const plausible=area>total*.08 && area<total*.9 &&
          maxX-minX+1>pitchX*.3 && maxY-minY+1>pitchY*.3 && distance<maximumSeedDistance;
        const score=plausible ? area*fill/(1+distance*4) : -1;
        if(!best||score>best.score) best={score,cx,cy,area,fill,distance,threshold,component,left,top,patchWidth};
      }
      if(best&&best.score>0) {
        squares.push({column,row,x:best.cx,y:best.cy,area:best.area,fill:best.fill,confidence:Math.max(.05,1-best.distance/maximumSeedDistance)});
        for(const index of best.component) {
          const px=index%best.patchWidth, py=Math.floor(index/best.patchWidth);
          acceptedMask[(best.top+py)*width+best.left+px]=255;
        }
      }
    }
  }
  return {squares,acceptedMask};
}

function otsuFromHistogram(histogram, offset) {
  const total=histogram.reduce((sum,value)=>sum+value,0);
  let weighted=0;
  for(let i=0;i<histogram.length;i++) weighted+=(i-offset)*histogram[i];
  let background=0, backgroundSum=0, best=-1, threshold=0;
  for(let i=0;i<histogram.length;i++) {
    background+=histogram[i];
    if(!background) continue;
    const foreground=total-background;
    if(!foreground) break;
    backgroundSum+=(i-offset)*histogram[i];
    const m0=backgroundSum/background, m1=(weighted-backgroundSum)/foreground;
    const variance=background*foreground*(m0-m1)**2;
    if(variance>best) {best=variance;threshold=i-offset;}
  }
  return threshold;
}

function clusterAxis(values, count, initial) {
  const spacings=initial.slice(1).map((value,i)=>value-initial[i]);
  const pitch=median(spacings);
  const length=Math.ceil(values.reduce((maximum,value)=>Math.max(maximum,value),0))+2;
  const histogram=new Float64Array(length);
  for(const value of values) histogram[Math.max(0,Math.min(length-1,Math.round(value)))]++;
  const radius=Math.max(1,Math.round(pitch*.16)),smooth=new Float64Array(length);
  for(let i=0;i<length;i++) for(let d=-radius;d<=radius;d++) if(i+d>=0&&i+d<length) smooth[i]+=histogram[i+d];
  const candidates=Array.from({length},(_,i)=>i).sort((a,b)=>smooth[b]-smooth[a]);
  const centers=[];
  for(const candidate of candidates) {
    if(centers.every(center=>Math.abs(center-candidate)>pitch*.55)) centers.push(candidate);
    if(centers.length===count) break;
  }
  centers.sort((a,b)=>a-b);
  const refined=centers.map(center=>{
    const nearby=values.filter(value=>Math.abs(value-center)<pitch*.36);
    return nearby.length?median(nearby):center;
  });
  const validSpacings=refined.slice(1).map((value,i)=>value-refined[i]).filter(value=>value>pitch*.55&&value<pitch*1.45);
  const latticePitch=validSpacings.length?median(validSpacings):pitch;
  const latticeOrigin=median(refined.map((value,i)=>value-latticePitch*i));
  return refined.map((value,i)=>Math.abs(value-(latticeOrigin+latticePitch*i))>latticePitch*.4?latticeOrigin+latticePitch*i:value);
}

function nearestIndex(value, centers) {
  let best=0,distance=Infinity;
  for(let i=0;i<centers.length;i++) {const d=Math.abs(value-centers[i]);if(d<distance){distance=d;best=i;}}
  return {index:best,distance};
}

function refineAxisFromSeeds(values,seeds,pitch) {
  const groups=seeds.map(()=>[]);
  for(const value of values) {
    const nearest=nearestIndex(value,seeds);
    if(nearest.distance<pitch*.48) groups[nearest.index].push(value);
  }
  const measured=groups.map(group=>group.length?median(group):null);
  const shifts=measured.flatMap((value,index)=>value==null?[]:[value-seeds[index]]);
  const globalShift=shifts.length?median(shifts):0;
  return measured.map((value,index)=>value==null?seeds[index]+globalShift:value);
}

function estimateWrappedAxisSlope(points,coordinateKey,otherKey,pitch) {
  // Row/column phase is periodic.  Search for the cross-axis slope that makes
  // (coordinate - slope*otherCoordinate) concentrate most strongly at one
  // phase of the pitch.  Sampling keeps the cost bounded on 8K grids.
  const stride=Math.max(1,Math.floor(points.length/6000));
  const sampled=[];
  for(let i=0;i<points.length;i+=stride) sampled.push(points[i]);
  const score=(slope,trialPitch=pitch,items=sampled)=>{
    let cosine=0,sine=0;
    for(const point of items) {
      const angle=2*Math.PI*(point[coordinateKey]-slope*point[otherKey])/trialPitch;
      cosine+=Math.cos(angle);sine+=Math.sin(angle);
    }
    return Math.hypot(cosine,sine)/items.length;
  };
  let bestSlope=0,bestScore=-Infinity;
  for(let step=-80;step<=80;step++) {
    const slope=step*.0005,value=score(slope);
    if(value>bestScore) {bestSlope=slope;bestScore=value;}
  }
  const coarse=bestSlope;
  for(let step=-12;step<=12;step++) {
    const slope=coarse+step*.00005,value=score(slope);
    if(value>bestScore) {bestSlope=slope;bestScore=value;}
  }
  // Even moderately coherent phases can hide a duplicate line after a small
  // pitch error accumulates over hundreds of cells. Refine both pitch and
  // orientation unless the original phase is already very concentrated.
  if(bestScore>=.95) return {slope:bestSlope,coherence:bestScore,method:'phase'};
  const local=estimateNeighborAxisGeometry(points,coordinateKey,otherKey,pitch);
  if(bestScore<.2&&local) {
    // Pitch and tilt errors can cancel only when fitted jointly. With 300+
    // columns, a 0.3% pitch error or a small tilt error wraps the phase many
    // times, so separate one-dimensional searches see almost zero coherence.
    const coarseSample=sampled.filter((_,index)=>index%Math.max(1,Math.floor(sampled.length/1200))===0);
    let joint={slope:local.slope,pitch,coherence:-Infinity};
    for(let p=-25;p<=25;p++) for(let s=-20;s<=20;s++) {
      const trialPitch=pitch*(1+p*.002),trialSlope=local.slope+s*.001;
      const coherence=score(trialSlope,trialPitch,coarseSample);
      if(coherence>joint.coherence) joint={slope:trialSlope,pitch:trialPitch,coherence};
    }
    if(joint.coherence>.45) {
      let refined={...joint,coherence:score(joint.slope,joint.pitch)};
      for(let pass=0;pass<2;pass++) {
        const originPitch=refined.pitch;
        for(let p=-20;p<=20;p++) {
          const trialPitch=originPitch*(1+p*.00005),coherence=score(refined.slope,trialPitch);
          if(coherence>refined.coherence) refined={...refined,pitch:trialPitch,coherence};
        }
        const originSlope=refined.slope;
        for(let s=-20;s<=20;s++) {
          const trialSlope=originSlope+s*.00005,coherence=score(trialSlope,refined.pitch);
          if(coherence>refined.coherence) refined={...refined,slope:trialSlope,coherence};
        }
      }
      if(refined.coherence>=.8) return {...refined,method:'phase-joint'};
    }
  }
  if(local||bestScore>=.2) {
    let refinedPitch=pitch,refinedScore=-Infinity;
    let refinedSlope=bestSlope;
    for(const initialSlope of [bestSlope,...(local?[local.slope]:[])]) {
      for(let step=-100;step<=100;step++) {
        const trialPitch=pitch*(1+step*.00015),value=score(initialSlope,trialPitch);
        if(value>refinedScore) {refinedPitch=trialPitch;refinedSlope=initialSlope;refinedScore=value;}
      }
    }
    const slopeOrigin=refinedSlope;
    for(let step=-50;step<=50;step++) {
      const trialSlope=slopeOrigin+step*.0002,value=score(trialSlope,refinedPitch);
      if(value>refinedScore) {refinedSlope=trialSlope;refinedScore=value;}
    }
    if(refinedScore>=.8&&refinedScore>bestScore+.05) {
      return {slope:refinedSlope,pitch:refinedPitch,coherence:refinedScore,method:'phase-refined'};
    }
  }
  if(bestScore>=.2) return {slope:bestSlope,coherence:bestScore,method:'phase'};
  return {slope:local?.slope??0,coherence:bestScore,method:local==null?'none':'neighbors'};
}

function estimateNeighborAxisGeometry(points,coordinateKey,otherKey,pitch) {
  const buckets=new Map();
  for(const point of points) {
    const key=Math.floor(point[otherKey]/pitch);
    if(!buckets.has(key)) buckets.set(key,[]);
    buckets.get(key).push(point);
  }
  const stride=Math.max(1,Math.floor(points.length/6000));
  const slopes=[],spacings=[];
  for(let i=0;i<points.length;i+=stride) {
    const point=points[i],target=point[otherKey]+pitch;
    const bucket=Math.floor(target/pitch);
    let nearest=null,bestDistance=Infinity;
    for(let key=bucket-1;key<=bucket+1;key++) for(const candidate of buckets.get(key)||[]) {
      const along=candidate[otherKey]-point[otherKey];
      const across=candidate[coordinateKey]-point[coordinateKey];
      if(along<pitch*.7||along>pitch*1.3||Math.abs(across)>pitch*.3) continue;
      const distance=Math.abs(along-pitch)+Math.abs(across);
      if(distance<bestDistance) {nearest=candidate;bestDistance=distance;}
    }
    if(nearest) {
      const spacing=nearest[otherKey]-point[otherKey];
      slopes.push((nearest[coordinateKey]-point[coordinateKey])/spacing);
      spacings.push(spacing);
    }
  }
  return slopes.length>=Math.min(100,points.length*.05)
    ? {slope:median(slopes),pitch:median(spacings),pairs:slopes.length}
    : null;
}

function fitLatticeSeedPredictor(cells) {
  const items=[...cells.values()];
  const fit=key=>{
    let weights=items.map(()=>1),coefficients=[0,0,0];
    for(let pass=0;pass<4;pass++) {
      const matrix=Array.from({length:3},()=>Array(3).fill(0)),vector=Array(3).fill(0);
      for(let i=0;i<items.length;i++) {
        const item=items[i],terms=[1,item.column,item.row],weight=weights[i];
        for(let a=0;a<3;a++) {
          vector[a]+=weight*terms[a]*item[key];
          for(let b=0;b<3;b++) matrix[a][b]+=weight*terms[a]*terms[b];
        }
      }
      coefficients=solveSystem(matrix,vector);
      const residuals=items.map(item=>item[key]-(coefficients[0]+coefficients[1]*item.column+coefficients[2]*item.row));
      const center=median(residuals),sigma=Math.max(.1,1.4826*median(residuals.map(value=>Math.abs(value-center))));
      const limit=2.5*sigma;
      weights=residuals.map(value=>Math.abs(value-center)<=limit?1:limit/Math.abs(value-center));
    }
    return coefficients;
  };
  const x=fit('x'),y=fit('y');
  return (column,row)=>({
    x:x[0]+x[1]*column+x[2]*row,
    y:y[0]+y[1]*column+y[2]*row
  });
}

function refineCellAssignments(components,initialCells,columnCenters,rowCenters,pitchX,pitchY) {
  let cells=initialCells;
  for(let pass=0;pass<2&&cells.size>=10;pass++) {
    const predict=fitLatticeSeedPredictor(cells),refined=new Map();
    for(const component of components) {
      const baseColumn=nearestIndex(component.latticeX??component.x,columnCenters).index;
      const baseRow=nearestIndex(component.latticeY??component.y,rowCenters).index;
      let best=null;
      for(let row=Math.max(0,baseRow-2);row<=Math.min(rowCenters.length-1,baseRow+2);row++) {
        for(let column=Math.max(0,baseColumn-2);column<=Math.min(columnCenters.length-1,baseColumn+2);column++) {
          const expected=predict(column,row);
          const distance=Math.hypot((component.x-expected.x)/pitchX,(component.y-expected.y)/pitchY);
          if(!best||distance<best.distance) best={column,row,distance};
        }
      }
      if(!best||best.distance>.62) continue;
      const score=component.area*component.fill/(1+best.distance);
      const key=`${best.column},${best.row}`;
      if(!refined.has(key)||score>refined.get(key).score) refined.set(key,{...component,...best,score});
    }
    cells=refined;
  }
  return cells;
}

function extractSquaresGlobally(data,width,height,columnSeeds,rowSeeds,pitchX,pitchY,supportDistance=null) {
  const stride=width+1;
  const integral=new Float64Array((width+1)*(height+1));
  const integralCount=supportDistance?new Uint32Array(integral.length):null;
  for(let y=1;y<=height;y++) {
    let rowSum=0,rowCount=0;
    for(let x=1;x<=width;x++) {
      const i=(y-1)*width+x-1,valid=!supportDistance||supportDistance[i]>0;
      if(valid){rowSum+=data[i];rowCount++;}
      integral[y*stride+x]=integral[(y-1)*stride+x]+rowSum;
      if(integralCount)integralCount[y*stride+x]=integralCount[(y-1)*stride+x]+rowCount;
    }
  }
  const radius=Math.max(8,Math.round(Math.max(pitchX,pitchY)*1.35));
  const residual=new Int16Array(width*height), histogram=new Uint32Array(511);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const x0=Math.max(0,x-radius),x1=Math.min(width-1,x+radius),y0=Math.max(0,y-radius),y1=Math.min(height-1,y+radius);
    const sum=integral[(y1+1)*stride+x1+1]-integral[y0*stride+x1+1]-integral[(y1+1)*stride+x0]+integral[y0*stride+x0];
    const count=integralCount?integralCount[(y1+1)*stride+x1+1]-integralCount[y0*stride+x1+1]-integralCount[(y1+1)*stride+x0]+integralCount[y0*stride+x0]:(x1-x0+1)*(y1-y0+1);
    const mean=sum/Math.max(1,count);
    const value=Math.max(-255,Math.min(255,Math.round(data[y*width+x]-mean)));
    residual[y*width+x]=value;
    if(!supportDistance||supportDistance[y*width+x]>0)histogram[value+255]++;
  }
  const threshold=otsuFromHistogram(histogram,255);
  const mask=new Uint8Array(width*height);
  for(let i=0;i<mask.length;i++) if((!supportDistance||supportDistance[i]>0)&&residual[i]>threshold) mask[i]=1;
  const queue=new Int32Array(width*height),components=[];
  for(let start=0;start<mask.length;start++) {
    if(mask[start]!==1) continue;
    let head=0,tail=0;queue[tail++]=start;mask[start]=2;
    let area=0,sumX=0,sumY=0,minX=width,maxX=0,minY=height,maxY=0;
    const pixels=[];
    while(head<tail) {
      const index=queue[head++],x=index%width,y=Math.floor(index/width);pixels.push(index);
      area++;sumX+=x;sumY+=y;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      if(x>0&&mask[index-1]===1){mask[index-1]=2;queue[tail++]=index-1;}
      if(x+1<width&&mask[index+1]===1){mask[index+1]=2;queue[tail++]=index+1;}
      if(y>0&&mask[index-width]===1){mask[index-width]=2;queue[tail++]=index-width;}
      if(y+1<height&&mask[index+width]===1){mask[index+width]=2;queue[tail++]=index+width;}
    }
    const boxWidth=maxX-minX+1,boxHeight=maxY-minY+1,fill=area/(boxWidth*boxHeight);
    const plausible=area>pitchX*pitchY*.07&&area<pitchX*pitchY*.94&&
      boxWidth>pitchX*.2&&boxWidth<pitchX*1.08&&boxHeight>pitchY*.2&&boxHeight<pitchY*1.08&&
      boxWidth/boxHeight>.32&&boxWidth/boxHeight<3.1&&fill>.22;
    if(plausible) components.push({x:sumX/area,y:sumY/area,area,fill,boxWidth,boxHeight,pixels});
  }
  // Estimate the complete 2D lattice basis before assigning integer indices.
  // Independent nearest-X / nearest-Y assignment only works while accumulated
  // tilt stays below half a pitch.  On a wide, fine-pitch image the same true
  // row otherwise wraps into adjacent row numbers several times.
  const columnTilt=estimateWrappedAxisSlope(components,'x','y',pitchX);
  const rowTilt=estimateWrappedAxisSlope(components,'y','x',pitchY);
  // Global autocorrelation can miss the true pitch by a fraction of a pixel.
  // Across hundreds of rows that is enough to split one physical row between
  // two seed indices. Correct the seed spacing when local neighbor geometry
  // was needed for the row tilt as well.
  const localColumnPitch=columnTilt.method==='neighbors'
    ?estimateNeighborAxisGeometry(components,'y','x',pitchX):null;
  const localRowPitch=rowTilt.method==='neighbors'
    ?estimateNeighborAxisGeometry(components,'x','y',pitchY):null;
  const columnPitch=columnTilt.pitch??localColumnPitch?.pitch;
  const rowPitch=rowTilt.pitch??localRowPitch?.pitch;
  const correctedColumnSeeds=columnPitch&&Math.abs(columnPitch/pitchX-1)<.08
    ?columnSeeds.map((_,index)=>columnSeeds[Math.floor(columnSeeds.length/2)]+(index-Math.floor(columnSeeds.length/2))*columnPitch)
    :columnSeeds;
  const correctedRowSeeds=rowPitch&&Math.abs(rowPitch/pitchY-1)<.08
    ?rowSeeds.map((_,index)=>rowSeeds[Math.floor(rowSeeds.length/2)]+(index-Math.floor(rowSeeds.length/2))*rowPitch)
    :rowSeeds;
  const middleX=(width-1)/2,middleY=(height-1)/2;
  for(const component of components) {
    component.latticeX=component.x-columnTilt.slope*component.y;
    component.latticeY=component.y-rowTilt.slope*component.x;
  }
  const transformedColumnSeeds=correctedColumnSeeds.map(value=>value-columnTilt.slope*middleY);
  const transformedRowSeeds=correctedRowSeeds.map(value=>value-rowTilt.slope*middleX);
  const columnCenters=refineAxisFromSeeds(components.map(p=>p.latticeX),transformedColumnSeeds,pitchX);
  const rowCenters=refineAxisFromSeeds(components.map(p=>p.latticeY),transformedRowSeeds,pitchY);
  let cells=new Map();
  for(const component of components) {
    const column=nearestIndex(component.latticeX,columnCenters),row=nearestIndex(component.latticeY,rowCenters);
    if(column.distance>pitchX*.48||row.distance>pitchY*.48) continue;
    const score=component.area*component.fill/(1+column.distance/pitchX+row.distance/pitchY);
    const key=`${column.index},${row.index}`;
    if(!cells.has(key)||score>cells.get(key).score) cells.set(key,{...component,column:column.index,row:row.index,score});
  }
  cells=refineCellAssignments(components,cells,columnCenters,rowCenters,pitchX,pitchY);
  const acceptedMask=new Uint8Array(width*height),squares=[];
  for(const component of cells.values()) {
    for(const pixel of component.pixels) acceptedMask[pixel]=255;
    squares.push({column:component.column,row:component.row,x:component.x,y:component.y,area:component.area,fill:component.fill,confidence:Math.min(1,component.fill)});
  }

  // A single global threshold can miss large contiguous low-contrast regions.
  // Revisit every missing lattice cell with an independent local threshold;
  // contrast, component shape, fill and seed distance must still all pass.
  const recoveryCandidates=new Set();
  if(Math.min(pitchX,pitchY)>=6) {
    for(let row=0;row<rowCenters.length;row++) for(let column=0;column<columnCenters.length;column++) {
      if(!cells.has(`${column},${row}`)) recoveryCandidates.add(`${column},${row}`);
    }
  }
  let predictedCandidates=0;
  if(recoveryCandidates.size) {
    const seedPredictor=fitLatticeSeedPredictor(cells);
    const recovered=extractSquareCenters(
      data,width,height,columnCenters,rowCenters,pitchX,pitchY,recoveryCandidates,seedPredictor
    );
    for(let i=0;i<recovered.acceptedMask.length;i++) if(recovered.acceptedMask[i]) acceptedMask[i]=255;
    for(const square of recovered.squares) if(!cells.has(`${square.column},${square.row}`)) {
      squares.push({...square,recovered:true});
    }
    const occupied=new Set([...cells.keys(),...recovered.squares.map(square=>`${square.column},${square.row}`)]);
    for(const key of recoveryCandidates) if(!occupied.has(key)) {
      const [column,row]=key.split(',').map(Number),predicted=seedPredictor(column,row);
      if(predicted.x<0||predicted.x>=width||predicted.y<0||predicted.y>=height) continue;
      squares.push({column,row,x:predicted.x,y:predicted.y,area:0,fill:0,confidence:.35,predicted:true});
      predictedCandidates++;
    }
  }
  return {
    squares,acceptedMask,threshold,components:components.length,
    recovered:Math.max(0,squares.length-cells.size-predictedCandidates),predictedCandidates,
    columnCenters,rowCenters,
    latticeBasis:{columnTilt:columnTilt.slope,rowTilt:rowTilt.slope,columnCoherence:columnTilt.coherence,rowCoherence:rowTilt.coherence,columnMethod:columnTilt.method,rowMethod:rowTilt.method,columnSeedPitch:columnPitch??null,rowSeedPitch:rowPitch??null}
  };
}

function histogramPercentile(histogram, quantile) {
  const total=histogram.reduce((sum,value)=>sum+value,0);
  const target=total*quantile;
  let cumulative=0;
  for(let i=0;i<histogram.length;i++) {
    cumulative+=histogram[i];
    if(cumulative>=target) return i;
  }
  return histogram.length-1;
}

function thresholdCrossing(aPosition, aValue, bPosition, bValue, threshold) {
  if(aValue===bValue) return (aPosition+bPosition)/2;
  const fraction=Math.max(0,Math.min(1,(threshold-aValue)/(bValue-aValue)));
  return aPosition+(bPosition-aPosition)*fraction;
}

function centerAtThreshold(data,width,patch,seed,fullPitch,threshold,maximumSeedDistance=.32) {
  const {left,top,patchWidth,patchHeight,total}=patch;
  const mask=new Uint8Array(total);
  for(let py=0;py<patchHeight;py++) for(let px=0;px<patchWidth;px++) {
    if(data[(top+py)*width+left+px]>threshold) mask[py*patchWidth+px]=1;
  }
  const queue=new Int32Array(total);
  let best=null;
  for(let start=0;start<total;start++) {
    if(mask[start]!==1) continue;
    let head=0,tail=0;queue[tail++]=start;mask[start]=2;
    const pixels=[];
    let area=0,sumX=0,sumY=0;
    while(head<tail) {
      const index=queue[head++],px=index%patchWidth,py=Math.floor(index/patchWidth);
      pixels.push(index);area++;sumX+=px;sumY+=py;
      if(px>0&&mask[index-1]===1){mask[index-1]=2;queue[tail++]=index-1;}
      if(px+1<patchWidth&&mask[index+1]===1){mask[index+1]=2;queue[tail++]=index+1;}
      if(py>0&&mask[index-patchWidth]===1){mask[index-patchWidth]=2;queue[tail++]=index-patchWidth;}
      if(py+1<patchHeight&&mask[index+patchWidth]===1){mask[index+patchWidth]=2;queue[tail++]=index+patchWidth;}
    }
    const cx=left+sumX/area,cy=top+sumY/area;
    const normalizedX=Math.abs(cx-seed.x)/fullPitch.x;
    const normalizedY=Math.abs(cy-seed.y)/fullPitch.y;
    const distance=Math.hypot(normalizedX,normalizedY);
    // The image can contain simultaneous row-wise X shifts and column-wise Y
    // shifts.  Test each axis against half a cell independently: a Euclidean
    // radius rejected a valid diagonal displacement even when neither axis was
    // close enough to jump into the neighbouring lattice cell.
    const plausible=area>total*.06&&area<total*.9&&
      normalizedX<maximumSeedDistance&&normalizedY<maximumSeedDistance;
    const score=plausible?area/(1+distance*8):-1;
    if(!best||score>best.score) best={score,pixels,area};
  }
  if(!best||best.score<=0) return null;

  // Rounded corners of a clipped square can still provide a few apparent
  // opposing edges. They do not establish its missing full-object center.
  // Reject contact with the actual image boundary, not merely a cropped
  // search-window boundary (a complete near-edge square may remain valid).
  const height=Math.floor(data.length/width);
  if(best.pixels.some(index=>{
    const x=left+index%patchWidth,y=top+Math.floor(index/patchWidth);
    return x===0||y===0||x===width-1||y===height-1;
  })) return null;

  const rowBounds=new Map(),columnBounds=new Map();
  for(const index of best.pixels) {
    const px=index%patchWidth,py=Math.floor(index/patchWidth);
    const row=rowBounds.get(py)||[px,px];row[0]=Math.min(row[0],px);row[1]=Math.max(row[1],px);rowBounds.set(py,row);
    const column=columnBounds.get(px)||[py,py];column[0]=Math.min(column[0],py);column[1]=Math.max(column[1],py);columnBounds.set(px,column);
  }
  const maxRowSpan=Math.max(...[...rowBounds.values()].map(bounds=>bounds[1]-bounds[0]+1));
  const maxColumnSpan=Math.max(...[...columnBounds.values()].map(bounds=>bounds[1]-bounds[0]+1));
  const xMidpoints=[];
  for(const [py,bounds] of rowBounds) {
    if(bounds[1]-bounds[0]+1<maxRowSpan*.55||bounds[0]===0||bounds[1]===patchWidth-1) continue;
    const y=top+py,leftInside=left+bounds[0],rightInside=left+bounds[1];
    const leftEdge=thresholdCrossing(leftInside-1,data[y*width+leftInside-1],leftInside,data[y*width+leftInside],threshold);
    const rightEdge=thresholdCrossing(rightInside,data[y*width+rightInside],rightInside+1,data[y*width+rightInside+1],threshold);
    xMidpoints.push((leftEdge+rightEdge)/2);
  }
  const yMidpoints=[];
  for(const [px,bounds] of columnBounds) {
    if(bounds[1]-bounds[0]+1<maxColumnSpan*.55||bounds[0]===0||bounds[1]===patchHeight-1) continue;
    const x=left+px,topInside=top+bounds[0],bottomInside=top+bounds[1];
    const topEdge=thresholdCrossing(topInside-1,data[(topInside-1)*width+x],topInside,data[topInside*width+x],threshold);
    const bottomEdge=thresholdCrossing(bottomInside,data[bottomInside*width+x],bottomInside+1,data[(bottomInside+1)*width+x],threshold);
    yMidpoints.push((topEdge+bottomEdge)/2);
  }
  if(xMidpoints.length<Math.max(3,.35*maxColumnSpan)||yMidpoints.length<Math.max(3,.35*maxRowSpan)) return null;
  const x=median(xMidpoints),y=median(yMidpoints);
  const spread=Math.hypot(
    1.4826*median(xMidpoints.map(value=>Math.abs(value-x))),
    1.4826*median(yMidpoints.map(value=>Math.abs(value-y)))
  );
  return {x,y,spread,area:best.area,pixels:best.pixels,left,top,patchWidth};
}

function refineSquareCenters(data,width,height,squares,scale,pitchX,pitchY,analysisMask=null,analysisWidth=0,supportDistance=null) {
  // Coarse detection stays fast on the reduced image. Final coordinates come
  // from three nearby thresholds on the original pixels; opposing boundaries
  // are linearly interpolated to subpixel positions before their midpoints are
  // combined with medians.
  const fullPitch={x:pitchX/scale,y:pitchY/scale};
  return squares.map(square=>{
    const seed={x:square.x/scale,y:square.y/scale};
    // Small full-resolution squares can touch a 0.43-pitch patch boundary;
    // then otherwise valid opposite-edge measurements are discarded. Keep the
    // window below the next square's center while giving these edges room.
    // Include the full square and surrounding gap also at high magnification.
    // A 0.43-pitch window can contain almost only foreground, causing Otsu to
    // split the grain inside the square instead of separating its boundary.
    const radiusFactor=square.predicted?.72:.54;
    const maximumSeedDistance=square.predicted?.48:.32;
    const radiusX=Math.max(5,Math.round(fullPitch.x*radiusFactor));
    const radiusY=Math.max(5,Math.round(fullPitch.y*radiusFactor));
    const left=Math.max(0,Math.round(seed.x)-radiusX),right=Math.min(width-1,Math.round(seed.x)+radiusX);
    const top=Math.max(0,Math.round(seed.y)-radiusY),bottom=Math.min(height-1,Math.round(seed.y)+radiusY);
    const patchWidth=right-left+1,patchHeight=bottom-top+1,total=patchWidth*patchHeight;
    const borderPartial=left===0||top===0||right===width-1||bottom===height-1;
    // A clipped search *window* is not necessarily a clipped square. The
    // opposite-edge estimator below rejects spans touching the window edge,
    // so let it decide whether a complete center can still be measured.
    const histogram=new Uint32Array(256);
    let histogramTotal=0;
    for(let y=top;y<=bottom;y++) for(let x=left;x<=right;x++){
      if(supportDistance){
        const sx=Math.min(analysisWidth-1,Math.floor(x*scale)),sy=Math.min(Math.floor(supportDistance.length/analysisWidth)-1,Math.floor(y*scale));
        if(supportDistance[sy*analysisWidth+sx]===0)continue;
      }
      histogram[data[y*width+x]]++;histogramTotal++;
    }
    if(histogramTotal<total*.2)return {...square,borderPartial,usedForFit:false,confidence:0,refinementRejection:'scan-support'};
    const otsu=otsuThreshold(histogram,histogramTotal);
    const dark=histogramPercentile(histogram,.1),bright=histogramPercentile(histogram,.9);
    const contrast=bright-dark;
    // A two-level patch has a whole plateau of equally optimal Otsu
    // thresholds. Picking its first bin measures almost at the dark edge,
    // magnifying pixel-phase/blur bias. Keep Otsu segmentation but constrain
    // the three localization thresholds to the central contrast range.
    const threshold=Math.max(dark+.35*contrast,Math.min(dark+.65*contrast,otsu));
    const delta=Math.max(2,Math.round(contrast*.04));
    const patch={left,top,patchWidth,patchHeight,total};
    const estimates=[threshold-delta,threshold,threshold+delta]
      .map(value=>centerAtThreshold(data,width,patch,seed,fullPitch,Math.max(1,Math.min(254,value)),maximumSeedDistance))
      .filter(Boolean);
    if(estimates.length<2) return {...square,borderPartial,usedForFit:false,confidence:0,refinementRejection:'threshold'};
    const refinedX=median(estimates.map(item=>item.x)),refinedY=median(estimates.map(item=>item.y));
    const normalizedRefinementX=Math.abs(refinedX-seed.x)/fullPitch.x;
    const normalizedRefinementY=Math.abs(refinedY-seed.y)/fullPitch.y;
    const refinementDistance=Math.hypot(normalizedRefinementX,normalizedRefinementY);
    const maximumRefinementDistance=square.predicted?.48:.22;
    if(normalizedRefinementX>maximumRefinementDistance||normalizedRefinementY>maximumRefinementDistance) {
      return {...square,borderPartial,usedForFit:false,confidence:0,refinementRejection:'distance'};
    }
    const thresholdStability=median(estimates.map(item=>Math.hypot(item.x-refinedX,item.y-refinedY)));
    const symmetrySpread=median(estimates.map(item=>item.spread));
    const tolerance=Math.max(.3,Math.min(fullPitch.x,fullPitch.y)*.035);
    const stabilityWeight=Math.exp(-((thresholdStability/tolerance)**2));
    const spreadWeight=Math.exp(-((symmetrySpread/(tolerance*2))**2));
    const confidence=Math.max(.05,Math.min(1,square.confidence*stabilityWeight*spreadWeight));
    if(analysisMask&&analysisWidth) {
      const representative=estimates.reduce((best,item)=>
        Math.hypot(item.x-refinedX,item.y-refinedY)<Math.hypot(best.x-refinedX,best.y-refinedY)?item:best
      );
      const analysisHeight=Math.floor(analysisMask.length/analysisWidth);
      for(const index of representative.pixels) {
        const fullX=representative.left+(index%representative.patchWidth);
        const fullY=representative.top+Math.floor(index/representative.patchWidth);
        const x=Math.max(0,Math.min(analysisWidth-1,Math.floor(fullX*scale)));
        const y=Math.max(0,Math.min(analysisHeight-1,Math.floor(fullY*scale)));
        analysisMask[y*analysisWidth+x]=255;
      }
    }
    return {
      ...square,x:refinedX*scale,y:refinedY*scale,confidence,usedForFit:true,borderPartial,
      coarseX:square.x,coarseY:square.y,
      refinementPixels:Math.hypot(refinedX-seed.x,refinedY-seed.y),
      thresholdStability,symmetrySpread
    };
  });
}

function trimUnreliableEdgeRows(squares,rowCenters,columnCount) {
  const minimumReliable=Math.max(4,Math.ceil(columnCount*.5));
  const reliableCount=row=>squares.filter(p=>p.row===row&&p.usedForFit!==false).length;
  const hasBorderPartial=row=>squares.some(p=>p.row===row&&p.borderPartial);
  let first=0,last=rowCenters.length-1;
  // Lattice extrapolation can create at most one clipped seed at either image
  // boundary.  Never peel multiple rows: repeated low-coverage rows indicate a
  // detection-quality problem that must remain visible to quality control.
  if(first<last&&hasBorderPartial(first)&&reliableCount(first)<minimumReliable) first++;
  if(last>first&&hasBorderPartial(last)&&reliableCount(last)<minimumReliable) last--;
  if(first===0&&last===rowCenters.length-1) return {squares,rowCenters,trimmedTop:0,trimmedBottom:0};
  return {
    squares:squares.filter(p=>p.row>=first&&p.row<=last).map(p=>({...p,row:p.row-first})),
    rowCenters:rowCenters.slice(first,last+1),
    trimmedTop:first,trimmedBottom:rowCenters.length-1-last
  };
}

function fitLinesFromSquares(squares, columnCount, rowCount, columnSeeds, rowSeeds) {
  const vertical=[];
  for(let column=0;column<columnCount;column++) {
    const reliable=squares.filter(p=>p.column===column&&p.usedForFit!==false);
    const selected=reliable.length>=4?reliable:squares.filter(p=>p.column===column);
    const fit=selected.length>=2?robustStraightFit(selected.map(p=>[p.y,p.x]))
      :{slope:0,intercept:columnSeeds[column],samples:selected.length,totalSamples:selected.length};
    vertical.push({...fit,measurements:reliable.map(p=>({y:rowSeeds[p.row],x:p.x,confidence:Math.max(.05,p.confidence||0)}))});
  }
  const horizontal=[];
  for(let row=0;row<rowCount;row++) {
    const reliable=squares.filter(p=>p.row===row&&p.usedForFit!==false);
    const selected=reliable.length>=4?reliable:squares.filter(p=>p.row===row);
    const fit=selected.length>=2?robustStraightFit(selected.map(p=>[p.x,p.y]))
      :{slope:0,intercept:rowSeeds[row],samples:selected.length,totalSamples:selected.length};
    horizontal.push({...fit,measurements:reliable.map(p=>({x:columnSeeds[p.column],y:p.y,confidence:Math.max(.05,p.confidence||0)}))});
  }
  return {vertical,horizontal};
}

async function analyzeOriented(imagePath,options,metadata,pose){
  const size=Math.min(metadata.width,metadata.height);
  // Refine pose on a small probe, then resample the full scan only once.
  const crop=Math.min(1200,Math.floor(size*.7)),margin=Math.floor((size-crop)/2);
  const probe=await sharp(imagePath,imageInputOptions).extract({left:margin,top:margin,width:crop,height:crop})
    .rotate(-pose.angleDegrees,{background:'#000'}).png().toBuffer();
  const remaining=await estimateOrientation(probe,await sharp(probe).metadata());
  const residualDegrees=remaining.confidence>.25&&Math.abs(remaining.angleDegrees)<3?remaining.angleDegrees:0;
  const degrees=pose.angleDegrees+residualDegrees;
  const expanded=await sharp(imagePath,imageInputOptions).extract({left:0,top:0,width:size,height:size})
    .rotate(-degrees,{background:'#000'}).png().toBuffer();
  const expandedMetadata=await sharp(expanded).metadata();
  const alignedImage=await sharp(expanded).extract({left:Math.floor((expandedMetadata.width-size)/2),top:Math.floor((expandedMetadata.height-size)/2),width:size,height:size}).png().toBuffer();
  const alignedMetadata=await sharp(alignedImage).metadata();
  const result=await analyze(alignedImage,{...options,filename:options.filename||path.basename(typeof imagePath==='string'?imagePath:'uploaded.tif'),orientationNormalized:true});
  const workingTransform=rotationTransform(size,size,-degrees,expandedMetadata.width,expandedMetadata.height),back=workingTransform.inverse;
  result.centers=result.centers.map(p=>{const q=back(p.x,p.y),coarse=back(p.coarseX,p.coarseY);return {...p,...q,coarseX:coarse.x,coarseY:coarse.y};})
    .filter(p=>p.x>=0&&p.y>=0&&p.x<size&&p.y<size);
  const columns=Array.from({length:result.vertical.length},(_,i)=>i),rows=Array.from({length:result.horizontal.length},(_,i)=>i);
  const fitted=fitLinesFromSquares(result.centers,columns.length,rows.length,columns,rows);
  const distortion=computeDistortion(fitted.vertical,fitted.horizontal,columns,rows,1);
  const rectification=fitGridRectification(result.centers,1,distortion.referenceLattice);
  const image={width:metadata.width,height:metadata.height,specimenHeight:size};
  distortion.image=image;distortion.physical=result.distortion.physical;
  if(distortion.physical.fovMicrometers!=null)distortion.physical.nanometersPerPixel=distortion.physical.fovMicrometers*1000/(options.referenceScanWidth??metadata.width);
  units.attach(distortion);
  result.image=image;result.distortion=distortion;result.rectification=rectification;
  result.analysis.orientationNormalization={...pose,appliedDegrees:degrees,workingWidth:alignedMetadata.width,workingHeight:alignedMetadata.height,
    note:'Detection uses a pose-normalized scan; measured centers, field, angles and mask are mapped back to original image coordinates.'};
  if(rectification)result.pitch={x:rectification.columnPitchPx,y:rectification.rowPitchPx};
  const reliable=result.centers.filter(p=>p.usedForFit!==false);
  const residual={vertical:scalarStats(reliable.map(p=>Math.abs(p.x-fitted.vertical[p.column].slope*p.y-fitted.vertical[p.column].intercept))),
    horizontal:scalarStats(reliable.map(p=>Math.abs(p.y-fitted.horizontal[p.row].slope*p.x-fitted.horizontal[p.row].intercept)))};
  result.quality.lineFitResidual=residual;result.squareExtraction.detected=result.centers.length;
  result.quality.fitRate=distortion.fitSampleCount/Math.max(1,result.centers.length);
  // The normalized working scan already counted only visible specimen cells.
  // Returned coarse/edge candidates are not a coverage numerator.
  if(distortion.fitResidualStats.p95>.1*Math.min(result.pitch.x,result.pitch.y)&&!result.quality.warnings.includes('smooth-field fit residual P95 exceeds 10% of the grid pitch'))
    result.quality.warnings.push('smooth-field fit residual P95 exceeds 10% of the grid pitch');
  if(distortion.fitResidualStats.p95>Math.max(2,distortion.stats.p95*.5)&&!result.quality.warnings.includes('center-to-field residual exceeds half the field P95 and 2 px; mode interpretation requires review'))
    result.quality.warnings.push('center-to-field residual exceeds half the field P95 and 2 px; mode interpretation requires review');
  result.quality.status=result.quality.warnings.length?'review':'ok';
  distortion.measurementQuality={pitchPriorError:result.quality.pitchPriorError,detectionRate:result.quality.detectionRate};
  result.vertical=fitted.vertical.map((line,index)=>({index,orientation:'vertical',x1:line.intercept,y1:0,x2:line.slope*size+line.intercept,y2:size,
    points:[{x:line.intercept,y:0},{x:line.slope*size+line.intercept,y:size}],samples:line.samples}));
  result.horizontal=fitted.horizontal.map((line,index)=>({index,orientation:'horizontal',x1:0,y1:line.intercept,x2:size,y2:line.slope*size+line.intercept,
    points:[{x:0,y:line.intercept},{x:size,y:line.slope*size+line.intercept}],samples:line.samples}));
  if(options.cacheResult!==false){
    if(latestSquareMaskPng){
      const mask=await sharp(latestSquareMaskPng).rotate(degrees,{background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
      const m=await sharp(mask).metadata();
      const maskTransform=rotationTransform(size,size,degrees,m.width,m.height),origin=back(0,0);
      const left=Math.round(Math.floor((m.width-size)/2)+maskTransform.tx-origin.x);
      const top=Math.round(Math.floor((m.height-size)/2)+maskTransform.ty-origin.y);
      latestSquareMaskPng=await sharp(mask).extract({left,top,width:size,height:size})
        .extend({bottom:metadata.height-size,background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
    }
    latestAnalysisContext={...latestAnalysisContext,vertical:fitted.vertical,horizontal:fitted.horizontal,columnSeeds:columns,rowSeeds:rows,inv:1,image,
      physical:distortion.physical,rectification,distortion,quality:result.quality};
  }
  return result;
}

async function analyze(imagePath=DEFAULT_IMAGE,options={}) {
  const inputOptions=imageInputOptions;
  const metadata=await sharp(imagePath,inputOptions).metadata();
  if(!options.orientationNormalized&&options.normalizeOrientation!==false){
    const pose=await estimateOrientation(imagePath,metadata);
    if(pose.confidence>.25&&Math.abs(pose.angleDegrees)>.8&&Math.abs(pose.angleDegrees)<=45)
      return analyzeOriented(imagePath,options,metadata,pose);
  }
  const sourceFilename=path.basename(options.filename||(typeof imagePath==='string'?imagePath:'uploaded.tif'));
  const referenceScanWidth=options.referenceScanWidth??metadata.width;
  if(!Number.isFinite(referenceScanWidth)||referenceScanWidth<=0)throw new Error('Reference scan width must be positive');
  const acquisition=acquisitionFromFilename(sourceFilename,referenceScanWidth);
  const suppliedFov=options.fovMicrometers;
  if(suppliedFov!=null && (!Number.isFinite(suppliedFov)||suppliedFov<=0)) throw new Error('FOV must be a positive number in micrometers');
  // Parameter-series filenames need not encode magnification. For this known
  // approximately 1 µm grid, supplied FOV supplies a soft search prior only.
  if(acquisition.expectedPitch==null&&suppliedFov!=null){
    acquisition.expectedPitch=referenceScanWidth/suppliedFov;
    acquisition.pitchPriorSource='user-supplied FOV, approximately 1 µm specimen pitch';
  }
  // Every supplied SEM file contains a square scan followed by a footer:
  // 1024×1086, 4096×4342, 8192×8686, ... .  Cropping at 92% cut roughly
  // 1.5 valid grid rows from the square scan.  Use the known image geometry
  // instead, while still behaving safely for images without a footer.
  const specimenHeight = Math.min(metadata.width,metadata.height);
  const desiredAnalysisWidth=acquisition.expectedPitch
    ? Math.round(metadata.width*32/acquisition.expectedPitch)
    : 1500;
  const analysisWidth=acquisition.expectedPitch
    ? Math.min(metadata.width,2500,Math.max(Math.min(metadata.width,700),desiredAnalysisWidth))
    : Math.min(1500,metadata.width);
  const scale = analysisWidth / metadata.width;
  const analysisHeight = Math.round(specimenHeight * scale);
  const expectedAnalysisPitch=acquisition.expectedPitch?acquisition.expectedPitch*scale:null;
  const { data, info } = await sharp(imagePath,inputOptions)
    .extract({ left: 0, top: 0, width: metadata.width, height: specimenHeight })
    .resize({ width: analysisWidth, height: analysisHeight, fit: 'fill' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });

  const verticalProfile = new Float64Array(info.width);
  const horizontalProfile = new Float64Array(info.height);
  // Rotation pads corners with constant pixels. Only then use central strips:
  // ordinary scans need their full profiles, especially fine low-contrast grids.
  const cornerSize=Math.max(4,Math.round((expectedAnalysisPitch??32)*.2));
  let constantCorners=0;
  for(const [left,top] of [[0,0],[info.width-cornerSize,0],[0,info.height-cornerSize],
    [info.width-cornerSize,info.height-cornerSize]]) {
    let minimum=255,maximum=0;
    for(let y=top;y<top+cornerSize;y++) for(let x=left;x<left+cornerSize;x++) {
      const value=data[y*info.width+x];minimum=Math.min(minimum,value);maximum=Math.max(maximum,value);
    }
    if(maximum-minimum<=1) constantCorners++;
  }
  const paddedCorners=constantCorners>=2;
  const scanSupportDistance=paddedCorners?paddingDistance(data,info.width,info.height):null;
  const verticalCounts=scanSupportDistance?new Uint32Array(info.width):null;
  const horizontalCounts=scanSupportDistance?new Uint32Array(info.height):null;
  // A long cross-axis projection erases a fine tilted lattice: a <1 degree
  // tilt accumulates several pitches across 4K. A short central band retains
  // the fundamental period; full-frame component detection still follows.
  const band=Math.max(24,Math.round((expectedAnalysisPitch??32)*8));
  const profileLeft=Math.max(0,Math.floor((info.width-band)/2)),profileRight=Math.min(info.width,profileLeft+band);
  const profileTop=Math.max(0,Math.floor((info.height-band)/2)),profileBottom=Math.min(info.height,profileTop+band);
  for (let y = 0; y < info.height; y++) {
    const row = y * info.width;
    for (let x = 0; x < info.width; x++) {
      const v = data[row + x];
      if(scanSupportDistance&&scanSupportDistance[row+x]===0)continue;
      if(!paddedCorners||(y>=profileTop&&y<profileBottom)){verticalProfile[x]+=v;if(verticalCounts)verticalCounts[x]++;}
      if(!paddedCorners||(x>=profileLeft&&x<profileRight)){horizontalProfile[y]+=v;if(horizontalCounts)horizontalCounts[y]++;}
    }
  }
  for (let x = 0; x < info.width; x++) verticalProfile[x] /= verticalCounts?Math.max(1,verticalCounts[x]):info.height;
  for (let y = 0; y < info.height; y++) horizontalProfile[y] /= horizontalCounts?Math.max(1,horizontalCounts[y]):info.width;

  const verticalSeeds=findPeriodicCenters(verticalProfile,expectedAnalysisPitch,verticalCounts);
  const horizontalSeeds=findPeriodicCenters(horizontalProfile,expectedAnalysisPitch,horizontalCounts);
  const squareExtraction = extractSquaresGlobally(
    data, info.width, info.height,
    verticalSeeds.positions, horizontalSeeds.positions,
    verticalSeeds.pitch, horizontalSeeds.pitch,scanSupportDistance
  );
  const localizationSigma=Math.min(verticalSeeds.pitch,horizontalSeeds.pitch)/scale>=24
    ?Math.min(2,Math.min(verticalSeeds.pitch,horizontalSeeds.pitch)/scale*.01):0;
  let localizationImage=sharp(imagePath,inputOptions)
    .extract({ left:0, top:0, width:metadata.width, height:specimenHeight })
    .greyscale();
  if(localizationSigma>=.3)localizationImage=localizationImage.blur(localizationSigma);
  const {data:fullResolutionData}=await localizationImage.raw().toBuffer({resolveWithObject:true});
  let squareCenters = refineSquareCenters(
    fullResolutionData, metadata.width, specimenHeight,
    squareExtraction.squares, scale, verticalSeeds.pitch, horizontalSeeds.pitch,
    squareExtraction.acceptedMask,info.width,scanSupportDistance
  );
  if(paddedCorners){
    const distance=scanSupportDistance,margin=.42*Math.max(verticalSeeds.pitch,horizontalSeeds.pitch);
    squareCenters=squareCenters.map(p=>{
      const x=Math.max(0,Math.min(info.width-1,Math.round(p.x))),y=Math.max(0,Math.min(info.height-1,Math.round(p.y)));
      return distance[y*info.width+x]<margin?{...p,usedForFit:false,confidence:0,borderPartial:true,refinementRejection:'scan-support'}:p;
    });
  }
  const recoveredFromPredictions=squareCenters.filter(p=>p.predicted&&p.usedForFit!==false).length;
  squareCenters=squareCenters.filter(p=>!p.predicted||p.usedForFit!==false);
  squareExtraction.recovered+=recoveredFromPredictions;
  const trimmedRows=trimUnreliableEdgeRows(
    squareCenters,squareExtraction.rowCenters,squareExtraction.columnCenters.length
  );
  squareCenters=trimmedRows.squares;
  squareExtraction.rowCenters=trimmedRows.rowCenters;
  squareExtraction.trimmedTopRows=trimmedRows.trimmedTop;
  squareExtraction.trimmedBottomRows=trimmedRows.trimmedBottom;
  let squareMaskPng=null;
  if(options.makeMask!==false) {
    const rgbaMask=Buffer.alloc(info.width*info.height*4);
    for(let i=0;i<squareExtraction.acceptedMask.length;i++) if(squareExtraction.acceptedMask[i]) {
      const offset=i*4;
      rgbaMask[offset]=35;rgbaMask[offset+1]=235;rgbaMask[offset+2]=190;rgbaMask[offset+3]=175;
    }
    squareMaskPng=await sharp(rgbaMask,{raw:{width:info.width,height:info.height,channels:4}})
      .resize({width:metadata.width,height:specimenHeight,kernel:'nearest'}).png().toBuffer();
  }
  const fitted = fitLinesFromSquares(
    squareCenters, squareExtraction.columnCenters.length, squareExtraction.rowCenters.length,
    squareExtraction.columnCenters, squareExtraction.rowCenters
  );
  const vertical = fitted.vertical;
  const horizontal = fitted.horizontal;
  const inv = 1 / scale;
  const reliableCenters=squareCenters.filter(center=>center.usedForFit!==false);
  let rectification=fitGridRectification(squareCenters,inv);
  const lineFitResidual={
    vertical:scalarStats(reliableCenters.map(center=>
      Math.abs(center.x-(vertical[center.column].slope*center.y+vertical[center.column].intercept))*inv
    )),
    horizontal:scalarStats(reliableCenters.map(center=>
      Math.abs(center.y-(horizontal[center.row].slope*center.x+horizontal[center.row].intercept))*inv
    ))
  };
  const distortion = computeDistortion(vertical, horizontal, squareExtraction.columnCenters, squareExtraction.rowCenters, inv);
  rectification=fitGridRectification(squareCenters,inv,distortion.referenceLattice);
  distortion.image={width:metadata.width,height:metadata.height,specimenHeight};
  const physicalFov=suppliedFov??(acquisition.magnification?acquisition.fovMicrometers:null);
  distortion.physical={fovMicrometers:physicalFov,nanometersPerPixel:physicalFov==null?null:physicalFov*1000/referenceScanWidth,
    source:suppliedFov!=null?'user-supplied FOV':physicalFov==null?'unavailable':'estimated from magnification (not calibrated)'};
  units.attach(distortion);
  const detectedPitch={
    x:(squareExtraction.latticeBasis.columnSeedPitch??verticalSeeds.pitch)*inv,
    y:(squareExtraction.latticeBasis.rowSeedPitch??horizontalSeeds.pitch)*inv
  };
  const nominalExpectedCount=squareExtraction.columnCenters.length*squareExtraction.rowCenters.length;
  const rowDetected=Array(squareExtraction.rowCenters.length).fill(0);
  const columnDetected=Array(squareExtraction.columnCenters.length).fill(0);
  // At a tilted image boundary, many nominal lattice sites are outside the
  // scanned square. Divide by sites expected to be visible, not all rows or
  // columns; otherwise a fully detected clipped edge is marked as a hole.
  const reliableForCoverage=squareCenters.filter(center=>center.usedForFit!==false);
  const coveragePredictor=fitLatticeSeedPredictor(new Map(reliableForCoverage.map((center,index)=>[index,center])));
  const rowVisible=Array(rowDetected.length).fill(0),columnVisible=Array(columnDetected.length).fill(0);
  const visibleCells=new Set();
  const marginX=verticalSeeds.pitch*.25,marginY=horizontalSeeds.pitch*.25;
  for(let row=0;row<rowDetected.length;row++) for(let column=0;column<columnDetected.length;column++) {
    const predicted=coveragePredictor(column,row);
    if(predicted.x < -marginX||predicted.x > info.width-1+marginX||
       predicted.y < -marginY||predicted.y > info.height-1+marginY) continue;
    if(scanSupportDistance){
      const x=Math.max(0,Math.min(info.width-1,Math.round(predicted.x))),y=Math.max(0,Math.min(info.height-1,Math.round(predicted.y)));
      if(scanSupportDistance[y*info.width+x]<.42*Math.max(verticalSeeds.pitch,horizontalSeeds.pitch))continue;
    }
    visibleCells.add(`${column},${row}`);
    rowVisible[row]++;columnVisible[column]++;
  }
  for(const center of squareCenters) if(visibleCells.has(`${center.column},${center.row}`)) {
    rowDetected[center.row]++;columnDetected[center.column]++;
  }
  const expectedCount=visibleCells.size;
  const visibleDetected=new Set(squareCenters.filter(p=>visibleCells.has(`${p.column},${p.row}`)).map(p=>`${p.column},${p.row}`)).size;
  const detectionRate=expectedCount?visibleDetected/expectedCount:0;
  const rowCoverage=rowDetected.map((count,index)=>rowVisible[index]?Math.min(1,count/rowVisible[index]):null);
  const columnCoverage=columnDetected.map((count,index)=>columnVisible[index]?Math.min(1,count/columnVisible[index]):null);
  const interiorRows=rowCoverage.length>2?rowCoverage.slice(1,-1):rowCoverage;
  const interiorColumns=columnCoverage.length>2?columnCoverage.slice(1,-1):columnCoverage;
  const minimumInteriorRowCoverage=Math.min(...interiorRows.filter(value=>value!=null));
  const minimumInteriorColumnCoverage=Math.min(...interiorColumns.filter(value=>value!=null));
  const pitchPriorError=acquisition.expectedPitch?Math.max(
    Math.abs(detectedPitch.x-acquisition.expectedPitch)/acquisition.expectedPitch,
    Math.abs(detectedPitch.y-acquisition.expectedPitch)/acquisition.expectedPitch
  ):null;
  const warnings=[];
  if(acquisition.expectedPitch&&acquisition.expectedPitch<8) warnings.push('grid pitch below 8 px; center localization is sampling-limited');
  if(pitchPriorError!=null&&pitchPriorError>.2) warnings.push('detected pitch differs from the filename-based prior by more than 20%');
  if(detectionRate<.5) warnings.push('fewer than 50% of expected squares were detected');
  if(minimumInteriorRowCoverage<.6) warnings.push('at least one interior grid row has below 60% center coverage');
  if(minimumInteriorColumnCoverage<.6) warnings.push('at least one interior grid column has below 60% center coverage');
  if(distortion.fitSampleCount/Math.max(1,squareCenters.length)<.5) warnings.push('fewer than 50% of detected centers entered the distortion fit');
  if(lineFitResidual.vertical.p95==null||lineFitResidual.horizontal.p95==null) {
    warnings.push('row/column line-fit residual is unavailable because too few reliable centers were found');
  } else if(Math.max(lineFitResidual.vertical.p95,lineFitResidual.horizontal.p95)>.15*Math.min(detectedPitch.x,detectedPitch.y)) {
    warnings.push('row/column line-fit residual P95 exceeds 15% of the grid pitch');
  }
  if(distortion.fitResidualStats.p95>.1*Math.min(detectedPitch.x,detectedPitch.y)) warnings.push('smooth-field fit residual P95 exceeds 10% of the grid pitch');
  if(distortion.fitResidualStats.p95>Math.max(2,distortion.stats.p95*.5)) {
    warnings.push('center-to-field residual exceeds half the field P95 and 2 px; mode interpretation requires review');
  }
  if(!rectification) warnings.push('grid orientation is unavailable because too few reliable centers were found');
  if(rectification) {
    // Coverage alone cannot detect a wrong lattice count: its denominator is
    // the same seed count that may be wrong. Check against measured spacing.
    const expectedColumns=metadata.width/rectification.columnPitchPx;
    const expectedRows=specimenHeight/rectification.rowPitchPx;
    if(Math.abs(squareExtraction.columnCenters.length-expectedColumns)>Math.max(3,expectedColumns*.1)||
       Math.abs(squareExtraction.rowCenters.length-expectedRows)>Math.max(3,expectedRows*.1)) {
      warnings.push('grid row/column count is inconsistent with independently fitted grid spacing');
    }
  }
  const quality={
    status:warnings.length?'review':'ok',warnings,pitchPriorError,
    detectionRate,visibleDetected,visibleExpected:expectedCount,nominalExpected:nominalExpectedCount,
    fitRate:distortion.fitSampleCount/Math.max(1,squareCenters.length),
    minimumInteriorRowCoverage,minimumInteriorColumnCoverage,lineFitResidual
  };
  distortion.measurementQuality={pitchPriorError:quality.pitchPriorError,detectionRate:quality.detectionRate};
  if(options.cacheResult!==false) {
    latestSquareMaskPng=squareMaskPng;
    latestAnalysisContext={vertical,horizontal,columnSeeds:squareExtraction.columnCenters,rowSeeds:squareExtraction.rowCenters,inv,image:distortion.image,physical:distortion.physical,rectification,distortion,quality};
  }

  return {
    source:{filename:sourceFilename,...acquisition},
    image: { width: metadata.width, height: metadata.height, specimenHeight },
    analysis: {
      width:info.width,height:info.height,scale,expectedPitch:expectedAnalysisPitch,localizationSigma,
      pitchProfileRegion:paddedCorners?'short central bands (constant corner padding)':'full scan',
      latticeBasis:squareExtraction.latticeBasis
    },
    pitch:detectedPitch,
    rectification,
    quality,
    distortion,
    squareExtraction:{
      detected:squareCenters.length,expected:expectedCount,nominalExpected:nominalExpectedCount,
      recovered:squareExtraction.recovered,
      trimmedTopRows:squareExtraction.trimmedTopRows,trimmedBottomRows:squareExtraction.trimmedBottomRows,
      rowCoverage,columnCoverage,rowVisible,columnVisible
    },
    centers:squareCenters.map(p=>({
      column:p.column,row:p.row,x:p.x*inv,y:p.y*inv,confidence:p.confidence,
      coarseX:(p.coarseX ?? p.x)*inv,coarseY:(p.coarseY ?? p.y)*inv,
      refinementPixels:p.refinementPixels||0,thresholdStability:p.thresholdStability??null,
      symmetrySpread:p.symmetrySpread??null,usedForFit:p.usedForFit!==false,borderPartial:Boolean(p.borderPartial),
      refinementRejection:p.refinementRejection??null
    })),
    vertical: vertical.map((line,index) => {
      const points = [
        { x:line.intercept * inv, y:0 },
        { x:(line.slope * (info.height - 1) + line.intercept) * inv, y:specimenHeight }
      ];
      return { index,orientation:'vertical',x1:points[0].x, y1:points[0].y, x2:points[1].x, y2:points[1].y, points, samples:line.samples };
    }),
    horizontal: horizontal.map((line,index) => {
      const points = [
        { x:0, y:line.intercept * inv },
        { x:metadata.width, y:(line.slope * (info.width - 1) + line.intercept) * inv }
      ];
      return { index,orientation:'horizontal',x1:points[0].x, y1:points[0].y, x2:points[1].x, y2:points[1].y, points, samples:line.samples };
    })
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/image') {
      const png = await sharp(currentImagePath,imageInputOptions).png().toBuffer();
      return send(res, 200, png, 'image/png');
    }
    if (url.pathname === '/api/metadata') {
      const m = await sharp(currentImagePath,imageInputOptions).metadata();
      return send(res, 200, { filename:currentImageFilename, width:m.width, height:m.height });
    }
    if (url.pathname === '/api/source' && req.method === 'POST') {
      const encoded=String(req.headers['x-filename']||'uploaded.tif');
      const filename=path.basename(decodeURIComponent(encoded));
      return send(res,200,await useUploadedSource(req,filename));
    }
    if (url.pathname === '/api/source/default' && req.method === 'POST') {
      useDefaultSource();
      const m=await sharp(currentImagePath,imageInputOptions).metadata();
      return send(res,200,{filename:currentImageFilename,width:m.width,height:m.height});
    }
    if (url.pathname === '/api/square-mask') {
      if (!latestSquareMaskPng) return send(res, 404, { error:'Run grid extraction first' });
      return send(res, 200, latestSquareMaskPng, 'image/png');
    }
    if (url.pathname === '/api/rectified-image' && req.method === 'GET') {
      if(!latestAnalysisContext?.rectification) return send(res,409,{error:'Run grid extraction first'});
      if(url.searchParams.get('mode')==='full') {
        const {compensateImage}=require('./full-compensation');
        const corrected=await compensateImage(currentImagePath,latestAnalysisContext.distortion);
        const filename=`${path.parse(currentImageFilename).name.replace(/[^A-Za-z0-9._-]/g,'_')}-full-compensated.png`;
        res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
        return send(res,200,corrected.png,'image/png');
      }
      const filename=`${path.parse(currentImageFilename).name.replace(/[^A-Za-z0-9._-]/g,'_')}-rectified.png`;
      res.writeHead(200,{
        'Content-Type':'image/png','Content-Disposition':`attachment; filename="${filename}"`,
        'Cache-Control':'no-store'
      });
      await pipeline(rectifiedImagePipeline(currentImagePath,latestAnalysisContext.rectification,latestAnalysisContext.image.specimenHeight),res);
      return;
    }
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const settings=await readJson(req);
      return send(res, 200, await analyze(currentImagePath,{filename:currentImageFilename,fovMicrometers:settings.fovMicrometers}));
    }
    if(url.pathname==='/api/compensation-validation' && req.method==='POST') {
      if(!latestAnalysisContext?.distortion) return send(res,409,{error:'Run grid extraction first'});
      const source=currentImagePath,filename=currentImageFilename,c=latestAnalysisContext;
      const {compensateImage,validationSummary}=require('./full-compensation');
      const corrected=await compensateImage(source,c.distortion);
      const after=await analyze(corrected.png,{filename,makeMask:false,cacheResult:false,fovMicrometers:c.physical.fovMicrometers});
      return send(res,200,validationSummary(c.distortion,c.quality,after,corrected));
    }
    if (url.pathname === '/api/analyze-upload' && req.method === 'POST') {
      let filename='uploaded.tif',temporaryPath=null;
      try {
        const encoded=String(req.headers['x-filename']||filename);
        filename=path.basename(decodeURIComponent(encoded));
        if(!/\.tiff?$/i.test(filename)) return send(res,400,{error:'Only .tif and .tiff files are supported'});
        temporaryPath=await saveUpload(req,filename);
        const started=Date.now();
        const uploadedResult=await analyze(temporaryPath,{
          filename,makeMask:false,cacheResult:false
        });
        return send(res,200,analysisSummary(uploadedResult,(Date.now()-started)/1000));
      } finally {
        if(temporaryPath) fs.rmSync(temporaryPath,{force:true});
      }
    }
    if (url.pathname === '/api/distortion' && req.method === 'POST') {
      if(!latestAnalysisContext) return send(res,409,{error:'Run grid extraction first'});
      const exclusions=await readJson(req);
      const c=latestAnalysisContext;
      const distortion=computeDistortion(c.vertical,c.horizontal,c.columnSeeds,c.rowSeeds,c.inv,exclusions);
      distortion.image=c.image;distortion.physical=c.physical;
      units.attach(distortion);
      c.distortion=distortion;
      return send(res,200,distortion);
    }

    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC, relative);
    if (!file.startsWith(path.resolve(PUBLIC)) || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream');
  } catch (error) {
    console.error(error);
    if(res.headersSent) {res.destroy(error);return;}
    return send(res, 500, { error: error.message });
  }
});

process.on('exit',removeCurrentUpload);
if (require.main === module) server.listen(PORT, () => console.log(`SEM Grid Calibrator: http://localhost:${PORT}`));
module.exports = { analyze, rectifiedImagePipeline, server, computeDistortion, fitGridRectification, analysisSummary };

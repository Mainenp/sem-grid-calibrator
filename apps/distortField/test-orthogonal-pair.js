const fs=require('fs');
const path=require('path');
const sharp=require('sharp');
const {analyze,rectifiedImagePipeline,computeDistortion,fitGridRectification}=require('./server');
const {correction,transform}=require('./orthogonality');
const units=require('./public/units');
const OUT=path.resolve(process.argv[2]||path.join(__dirname,'results','2026-10-09-orthogonal-test'));
const CONFIG=process.argv[3];
if(!CONFIG) throw new Error('Usage: node test-orthogonal-pair.js output-directory pair.json');
const pair=JSON.parse(fs.readFileSync(CONFIG,'utf8'));
if(!Array.isArray(pair)||pair.length!==2||pair.some(s=>!s.file||!Number.isFinite(s.fov)||s.fov<=0)) {
  throw new Error('Configuration must contain two records with file and positive fov');
}
const SOURCES=pair.map(s=>({...s,file:path.resolve(path.dirname(path.resolve(CONFIG)),s.file)}));
function fieldFromCenters(centers,source) {
  const rows=source.distortion.rows,columns=source.distortion.columns;
  const rowSeeds=Array.from({length:rows},(_,i)=>i),columnSeeds=Array.from({length:columns},(_,i)=>i);
  const vertical=columnSeeds.map(()=>({measurements:[]})),horizontal=rowSeeds.map(()=>({measurements:[]}));
  for(const p of centers.filter(p=>p.usedForFit!==false)) {
    vertical[p.column].measurements.push({y:p.row,x:p.x,confidence:p.confidence});
    horizontal[p.row].measurements.push({x:p.column,y:p.y,confidence:p.confidence});
  }
  const field=computeDistortion(vertical,horizontal,columnSeeds,rowSeeds,1);
  field.image=source.image;field.physical=source.distortion.physical;units.attach(field);
  return field;
}
function summary(label,result,field=result.distortion,geometry=result.rectification) {
  const affineModeStats={};
  for(const mode of ['uniformScale','differentialScale','shear','rotationLike']) {
    const d=field.decomposition;
    const values=field.samples.map(p=>Math.abs(d.affine[mode])*Math.hypot(p.idealX-d.center.x,p.idealY-d.center.y)).sort((a,b)=>a-b);
    const stats={mean:values.reduce((s,v)=>s+v,0)/values.length,rms:Math.sqrt(values.reduce((s,v)=>s+v*v,0)/values.length),p95:values[Math.floor(.95*(values.length-1))],max:values.at(-1)};
    affineModeStats[mode]=stats;field.units.modes[mode]=units.stats(stats,field);
  }
  return {label,quality:result.quality,angleDeg:geometry?.includedAngleDegrees,
    detected:result.squareExtraction.detected,expected:result.squareExtraction.expected,
    stats:field.stats,units:field.units,modes:{...field.decomposition.stats,...affineModeStats},affineCoefficients:field.decomposition.affine,
    residual:field.fitResidualStats,physical:field.physical};
}
async function main() {
  fs.mkdirSync(OUT,{recursive:true});
  for(const s of SOURCES) if(!fs.existsSync(s.file)) throw new Error(`Missing source: ${s.file}`);
  const results=[];
  for(const s of SOURCES) {
    console.log('Analyzing',path.basename(s.file));
    results.push(await analyze(s.file,{makeMask:false,cacheResult:false,fovMicrometers:s.fov}));
  }
  const old=results[0],recent=results[1],angleOnly=correction(old.rectification);
  const transformed=old.centers.map(p=>transform(p,angleOnly.correctionMatrix,old.rectification.fittedCenter));
  const fixed=fieldFromCenters(transformed,old);
  const fittedGeometry=fitGridRectification(transformed,1);
  const fullFile=path.join(OUT,'first-batch-angle-only.png');
  await rectifiedImagePipeline(SOURCES[0].file,angleOnly,old.image.specimenHeight).toFile(fullFile);
  // Same 8192 px square, centered crop. Keeps resolution/pitch prior and scan
  // denominator unchanged; padded/cropped support is explicitly diagnosed.
  const metadata=await sharp(fullFile,{unlimited:true,limitInputPixels:false}).metadata();
  const size=old.image.specimenHeight;
  const padX=Math.max(0,size-metadata.width),padY=Math.max(0,size-metadata.height);
  const padded=await sharp(fullFile,{unlimited:true,limitInputPixels:false})
    .extend({left:Math.floor(padX/2),right:Math.ceil(padX/2),top:Math.floor(padY/2),bottom:Math.ceil(padY/2),background:'#000'})
    .png().toBuffer();
  const buffer=await sharp(padded,{unlimited:true,limitInputPixels:false})
    .extract({left:Math.floor((metadata.width+padX-size)/2),top:Math.floor((metadata.height+padY-size)/2),width:size,height:size})
    .png().toBuffer();
  await sharp(buffer).toFile(path.join(OUT,'first-batch-angle-only-same-scan.png'));
  const redetected=await analyze(buffer,{filename:path.basename(SOURCES[0].file),makeMask:false,cacheResult:false,fovMicrometers:SOURCES[0].fov});
  const records=[summary('first-original',old),summary('first-angle-only-fixed-centers',old,fixed,fittedGeometry),
    summary('first-angle-only-redetected',redetected),summary('second-original',recent)];
  // Reproduction check: rebuilding the input representation must not change fit.
  const rebuilt=fieldFromCenters(old.centers,old);
  if(Math.abs(rebuilt.stats.p95-old.distortion.stats.p95)>1e-6) throw new Error('Fixed-center fit does not reproduce baseline');
  // Re-fitting uses distance-based robust weights, which can change under
  // a non-orthogonal map. Exact matrix orthogonality is tested separately.
  if(Math.abs(fittedGeometry.includedAngleDegrees-90)>.01) throw new Error(`Angle-only refit failed: ${fittedGeometry.includedAngleDegrees}`);
  const payload={sources:SOURCES,correction:angleOnly,records,
    notes:['FOV and WD transcribed from original image footers; supplied FOV is not an independent pixel calibration.',
      'Fixed-center comparison holds detections, lattice labels and evaluation support constant; inherited quality is not a new validation.',
      'Redetected comparison includes bicubic interpolation, centered cropping/padding and detection changes.',
      'Working distance and view differ; one matched acquisition setting is not a controlled time/drift experiment.']};
  fs.writeFileSync(path.join(OUT,'comparison.json'),JSON.stringify(payload,null,2));
  const columns=['condition','quality','includedAngleDeg','detected','expected','mode','p95Px','p95ScanPercent','p95PitchPercent','p95Nm','fitResidualP95Px'];
  const rows=records.flatMap(r=>Object.entries({total:r.stats,...r.modes}).map(([mode,stats])=>{
    const v=mode==='total'?r.units.total:r.units.modes[mode];
    return [r.label,r.quality.status,r.angleDeg,r.detected,r.expected,mode,stats.p95,v.scanPercent.p95,v.pitchPercent.p95,v.nm.p95,r.residual.p95];
  }));
  fs.writeFileSync(path.join(OUT,'comparison.csv'),[columns,...rows].map(row=>row.join(',')).join('\n')+'\n');
  console.log(JSON.stringify(records.map(r=>({condition:r.label,quality:r.quality.status,angle:r.angleDeg,total:r.stats.p95,nonlinear:r.modes.nonlinear.p95,residual:r.residual.p95})),null,2));
}
if(require.main===module) main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fieldFromCenters};

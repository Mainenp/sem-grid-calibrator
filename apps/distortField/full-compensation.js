const sharp=require('sharp');
const imageInputOptions=require('./image-input');
const {coordinateAt,indexAt}=require('./cluster-lattice');
const {evaluateField}=require('./field-basis');

function evaluate(model,column,row) {
  const f=model.smooth,l=model.lattice;
  const {dx,dy}=evaluateField(f,column,row);
  const a=coordinateAt(l.columnCoordinates,column)-l.meanColumn,b=coordinateAt(l.rowCoordinates,row)-l.meanRow;
  return {x:l.centerX+l.c*a-l.d*b+dx,y:l.centerY+l.d*a+l.c*b+dy};
}
function validateModel(model) {
  if(!model?.smooth||!model?.lattice) throw new Error('Full compensation model is unavailable; re-extract the grid');
  const f=model.smooth,l=model.lattice,pitch=Math.hypot(l.c,l.d);
  const degree=f.degree||3,terms=(degree+1)*(degree+2)/2;
  if(![3,5].includes(degree)||f.dx?.length!==terms||f.dy?.length!==terms||
     ![...f.dx,...f.dy].every(Number.isFinite))throw new Error('Invalid displacement polynomial');
  if(f.columnCount<2||f.rowCount<2||!Number.isFinite(pitch)||pitch<=0) throw new Error('Invalid compensation lattice');
  const s=model.fitSupport;
  if(s&&(![s.minimumColumn,s.maximumColumn,s.minimumRow,s.maximumRow].every(Number.isFinite)||
     s.minimumColumn<0||s.minimumRow<0||s.maximumColumn>=f.columnCount||s.maximumRow>=f.rowCount||
     s.minimumColumn>=s.maximumColumn||s.minimumRow>=s.maximumRow))throw new Error('Invalid measured compensation support');
  let minimumJacobian=Infinity;
  for(let i=0;i<=20;i++) for(let j=0;j<=20;j++) {
    const c=i*(f.columnCount-1)/20,r=j*(f.rowCount-1)/20,h=.001;
    const a=evaluate(model,c+h,r),b=evaluate(model,c-h,r);
    const x=evaluate(model,c,r+h),y=evaluate(model,c,r-h);
    const det=((a.x-b.x)*(x.y-y.y)-(a.y-b.y)*(x.x-y.x))/(4*h*h*pitch*pitch);
    if(!Number.isFinite(det)||det<=.05||det>20) throw new Error('Compensation mapping folds or is ill-conditioned; inspect detection before exporting');
    minimumJacobian=Math.min(minimumJacobian,det);
  }
  return {pitch,minimumJacobian};
}
// Pull resampling: each output pixel looks up its location in the observed
// image. This avoids holes from pushing source pixels into a corrected grid.
async function compensateImage(input,field) {
  const quality=field.measurementQuality;
  if(quality&&(quality.pitchPriorError>.2||quality.detectionRate<.5))
    throw new Error('Compensation refused: grid pitch or detection coverage is unreliable; inspect grid numbering before exporting');
  if(Number.isFinite(field.fitResidualStats?.p95)&&Number.isFinite(field.stats?.p95)&&
     field.fitResidualStats.p95>Math.max(2,field.stats.p95*.5))
    throw new Error('Compensation refused: center-to-field residual is too large for reliable nonlinear correction; inspect clipped centers and specimen reference');
  const model=field.compensationModel,{pitch,minimumJacobian}=validateModel(model);
  const {data,info}=await sharp(input,imageInputOptions).greyscale().raw().toBuffer({resolveWithObject:true});
  const width=field.image.width,height=field.image.specimenHeight;
  const output=Buffer.alloc(width*height),l=model.lattice,f=model.smooth;
  const support=model.fitSupport||{minimumColumn:0,maximumColumn:f.columnCount-1,minimumRow:0,maximumRow:f.rowCount-1};
  let validPixels=0;
  for(let y=0;y<height;y++) {
    const row=indexAt(l.rowCoordinates,l.meanRow+(y-l.centerY)/pitch);
    if(row<support.minimumRow-.5||row>support.maximumRow+.5) continue;
    for(let x=0;x<width;x++) {
      const column=indexAt(l.columnCoordinates,l.meanColumn+(x-l.centerX)/pitch);
      if(column<support.minimumColumn-.5||column>support.maximumColumn+.5) continue;
      const p=evaluate(model,column,row),ix=Math.floor(p.x),iy=Math.floor(p.y);
      if(ix<0||iy<0||ix+1>=info.width||iy+1>=Math.min(height,info.height)) continue;
      const a=p.x-ix,b=p.y-iy,index=(iy*info.width+ix)*info.channels;
      const v=(1-b)*((1-a)*data[index]+a*data[index+info.channels])+
        b*((1-a)*data[index+info.width*info.channels]+a*data[index+(info.width+1)*info.channels]);
      output[y*width+x]=Math.round(v);validPixels++;
    }
    // Keep API responsive during large 8K/16K resampling jobs.
    if(y%64===0) await new Promise(resolve=>setImmediate(resolve));
  }
  const png=await sharp(output,{raw:{width,height,channels:1},limitInputPixels:false}).png().toBuffer();
  return {png,width,height,validFraction:validPixels/(width*height),minimumJacobian,
    method:`inverse resampling of square reference preserving replicated specimen intervals + robust degree-${f.degree||3} displacement; rotation, shear, scale and nonlinear terms`,
    limitations:['Black borders are outside fitted support and are not evidence of compensation.',
      'Resampling is restricted to measured grid bounds plus half a cell; report validFraction with every result.',
      'Same-image fit and re-detection validate internal consistency, not independent physical accuracy.']};
}
function magnitudeStats(values){
  if(!values.length)return {count:0,mean:null,rms:null,p95:null,max:null};
  const sorted=values.slice().sort((a,b)=>a-b),at=(sorted.length-1)*.95,i=Math.floor(at);
  return {count:sorted.length,mean:values.reduce((s,v)=>s+v,0)/values.length,
    rms:Math.sqrt(values.reduce((s,v)=>s+v*v,0)/values.length),
    p95:sorted[i]+(sorted[Math.ceil(at)]-sorted[i])*(at-i),max:sorted.at(-1)};
}
// Validate independently measured output centers against the ORIGINAL model's
// target. Re-detection may add/drop edge rows or shift grid numbering, so do
// not compare independently refitted grids as if they were the same cohort.
function compareCommonSupport(before,after){
  const measured=before.measuredSamples,model=before.compensationModel;
  if(!measured||!model)return {supported:false,reason:'Original measured centers are unavailable; re-analyze the source before validating compensation'};
  const l=model.lattice,pitch=Math.hypot(l.c,l.d),width=after.image.width,height=after.image.specimenHeight;
  const candidates=(after.centers||[]).filter(p=>p.usedForFit!==false&&[p.x,p.y].every(Number.isFinite));
  const size=pitch*.5,limit=pitch*.3,bins=new Map(),key=(x,y)=>Math.floor(x/size)+','+Math.floor(y/size);
  candidates.forEach((p,i)=>{const k=key(p.x,p.y),bin=bins.get(k)||[];bin.push(i);bins.set(k,bin);});
  const allTargets=measured.map(p=>({source:p,x:l.centerX+pitch*(coordinateAt(l.columnCoordinates,p.column)-l.meanColumn),
    y:l.centerY+pitch*(coordinateAt(l.rowCoordinates,p.row)-l.meanRow)}));
  // Declare eligibility geometrically BEFORE matching/error measurement. A
  // cell whose output footprint is clipped cannot provide a complete center.
  const targets=allTargets.filter(p=>p.x>=pitch*.5&&p.y>=pitch*.5&&p.x<width-1-pitch*.5&&p.y<height-1-pitch*.5);
  const proposals=[];
  for(const target of targets){
    const bx=Math.floor(target.x/size),by=Math.floor(target.y/size),near=[];
    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++)for(const i of bins.get((bx+ox)+','+(by+oy))||[]){
      const p=candidates[i],distance=Math.hypot(p.x-target.x,p.y-target.y);if(distance<=limit)near.push({index:i,distance});
    }
    near.sort((a,b)=>a.distance-b.distance);
    if(near.length&&(near.length===1||near[1].distance-near[0].distance>pitch*.1))proposals.push({target,...near[0]});
  }
  const multiplicity=new Map();for(const p of proposals)multiplicity.set(p.index,(multiplicity.get(p.index)||0)+1);
  const pairs=proposals.filter(p=>multiplicity.get(p.index)===1);
  const span=(list,axis)=>list.length?list.reduce((b,p)=>({lo:Math.min(b.lo,p[axis]),hi:Math.max(b.hi,p[axis])}),{lo:Infinity,hi:-Infinity}):{lo:0,hi:0};
  const x=span(targets,'x'),y=span(targets,'y'),mx=span(pairs.map(p=>p.target),'x'),my=span(pairs.map(p=>p.target),'y');
  const fraction=pairs.length/Math.max(1,targets.length),spanX=(mx.hi-mx.lo)/Math.max(pitch,x.hi-x.lo),spanY=(my.hi-my.lo)/Math.max(pitch,y.hi-y.lo);
  const original=magnitudeStats(pairs.map(p=>Math.hypot(p.target.source.dx,p.target.source.dy))),corrected=magnitudeStats(pairs.map(p=>p.distance));
  const eligibleFraction=targets.length/Math.max(1,allTargets.length);
  const supported=pairs.length>=10&&fraction>=.8&&spanX>=.8&&spanY>=.8&&eligibleFraction>=.5;
  const tolerance=original.p95===null?null:Math.max(.1,.1*original.p95);
  const status=!supported?'insufficient-common-support':corrected.p95>original.p95+tolerance?'worsened':corrected.p95<original.p95-tolerance?'improved':'similar';
  return {supported,status,expected:targets.length,matched:pairs.length,matchedFraction:fraction,spanX,spanY,
    totalSourceCenters:allTargets.length,excludedByOutputBoundary:allTargets.length-targets.length,eligibleFraction,
    before:original,after:corrected,reductionPercent:supported&&original.p95>1e-12?100*(1-corrected.p95/original.p95):null,
    reason:supported?'Same source cells and fixed compensation target; no output-lattice refit used for these distances':'Too few matching cells or insufficient spatial support; do not claim an improvement',
    criteria:{minimumMatched:10,minimumFraction:.8,minimumSpanFraction:.8,minimumEligibleFraction:.5,outputFootprintMarginPitchFraction:.5,maximumMatchingDistance:limit},
    limitation:'Same-image resampling consistency; not independent physical accuracy or cross-image generalization'};
}
function validationSummary(before,quality,after,corrected) {
  const ratio=after.distortion.stats.p95/Math.max(1e-12,before.stats.p95);
  const commonSupport=compareCommonSupport(before,after);
  const sameCounts=before.rows===after.distortion.rows&&before.columns===after.distortion.columns;
  return {before:{stats:before.stats,measuredStats:before.measuredStats,units:before.units,residual:before.fitResidualStats,referenceLattice:before.referenceLattice,quality},
    after:{stats:after.distortion.stats,measuredStats:after.distortion.measuredStats,units:after.distortion.units,residual:after.distortion.fitResidualStats,
      referenceLattice:after.distortion.referenceLattice,quality:after.quality,includedAngleDeg:after.rectification?.includedAngleDegrees},
    reductionPercent:commonSupport.reductionPercent??null,independentlyRefittedFieldReductionPercent:100*(1-ratio),
    commonSupport,fieldComparison:{sameGridCounts:sameCounts,beforeGrid:{rows:before.rows,columns:before.columns},afterGrid:{rows:after.distortion.rows,columns:after.distortion.columns},
      interpretation:'Independent field fits can use different support/reference; use commonSupport for paired improvement, even when grid counts match'},
    validFraction:corrected.validFraction,minimumJacobian:corrected.minimumJacobian,
    method:corrected.method,limitations:corrected.limitations,
    interpretation:'Report remaining P95, fit residual and quality together; near-zero is not a guarantee of absolute SEM accuracy.'};
}
module.exports={evaluate,validateModel,compensateImage,validationSummary,compareCommonSupport};

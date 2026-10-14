const sharp=require('sharp');
const imageInputOptions=require('./image-input');
const {coordinateAt,indexAt}=require('./cluster-lattice');

function evaluate(model,column,row) {
  const f=model.smooth,l=model.lattice;
  const u=2*column/(f.columnCount-1)-1,v=2*row/(f.rowCount-1)-1;
  const terms=[1,u,v,u*u,u*v,v*v,u*u*u,u*u*v,u*v*v,v*v*v];
  let dx=0,dy=0;
  for(let i=0;i<10;i++){dx+=f.dx[i]*terms[i];dy+=f.dy[i]*terms[i];}
  const a=coordinateAt(l.columnCoordinates,column)-l.meanColumn,b=coordinateAt(l.rowCoordinates,row)-l.meanRow;
  return {x:l.centerX+l.c*a-l.d*b+dx,y:l.centerY+l.d*a+l.c*b+dy};
}
function validateModel(model) {
  if(!model?.smooth||!model?.lattice) throw new Error('Full compensation model is unavailable; re-extract the grid');
  const f=model.smooth,l=model.lattice,pitch=Math.hypot(l.c,l.d);
  if(f.columnCount<2||f.rowCount<2||!Number.isFinite(pitch)||pitch<=0) throw new Error('Invalid compensation lattice');
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
  const model=field.compensationModel,{pitch,minimumJacobian}=validateModel(model);
  const {data,info}=await sharp(input,imageInputOptions).greyscale().raw().toBuffer({resolveWithObject:true});
  const width=field.image.width,height=field.image.specimenHeight;
  const output=Buffer.alloc(width*height),l=model.lattice,f=model.smooth;
  let validPixels=0;
  for(let y=0;y<height;y++) {
    const row=indexAt(l.rowCoordinates,l.meanRow+(y-l.centerY)/pitch);
    if(row<-.45||row>f.rowCount-1+.45) continue;
    for(let x=0;x<width;x++) {
      const column=indexAt(l.columnCoordinates,l.meanColumn+(x-l.centerX)/pitch);
      if(column<-.45||column>f.columnCount-1+.45) continue;
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
    method:'inverse resampling of square reference preserving replicated specimen intervals + robust cubic displacement; rotation, shear, scale and nonlinear terms',
    limitations:['Black borders are outside fitted support and are not evidence of compensation.',
      'Same-image fit and re-detection validate internal consistency, not independent physical accuracy.']};
}
function validationSummary(before,quality,after,corrected) {
  const ratio=after.distortion.stats.p95/Math.max(1e-12,before.stats.p95);
  return {before:{stats:before.stats,measuredStats:before.measuredStats,units:before.units,residual:before.fitResidualStats,referenceLattice:before.referenceLattice,quality},
    after:{stats:after.distortion.stats,measuredStats:after.distortion.measuredStats,units:after.distortion.units,residual:after.distortion.fitResidualStats,
      referenceLattice:after.distortion.referenceLattice,quality:after.quality,includedAngleDeg:after.rectification?.includedAngleDegrees},
    reductionPercent:100*(1-ratio),validFraction:corrected.validFraction,minimumJacobian:corrected.minimumJacobian,
    method:corrected.method,limitations:corrected.limitations,
    interpretation:'Report remaining P95, fit residual and quality together; near-zero is not a guarantee of absolute SEM accuracy.'};
}
module.exports={evaluate,validateModel,compensateImage,validationSummary};

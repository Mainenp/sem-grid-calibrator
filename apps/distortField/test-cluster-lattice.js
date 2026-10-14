const assert=require('node:assert/strict');
const {computeDistortion}=require('./server');
const {coordinateAt,indexAt,inferReference}=require('./cluster-lattice');
const {evaluate,compensateImage}=require('./full-compensation');
const sharp=require('sharp');

function scene({grouped=false,shear=0,curve=0}={}){
  const columns=61,rows=60,pitch=40,phase=[-.025,.05,-.025,0,0,0,0,0,0,0];
  const coords=n=>{const a=[0];for(let i=0;i<n-1;i++)a.push(a.at(-1)+1+(grouped?phase[i%10]:0));return a;};
  const cx=coords(columns),cy=coords(rows),columnSeeds=Array.from({length:columns},(_,i)=>i),rowSeeds=Array.from({length:rows},(_,i)=>i);
  const vertical=columnSeeds.map(()=>({measurements:[]})),horizontal=rowSeeds.map(()=>({measurements:[]}));
  const samples=[];
  for(let row=0;row<rows;row++)for(let column=0;column<columns;column++){
    const u=(column-30)/30,v=(row-30)/30;
    const x=20+pitch*cx[column]+shear*pitch*cy[row]+curve*u*u+.015*Math.sin(row*3+column*7);
    const y=20+pitch*cy[row]+curve*.7*v*v;
    vertical[column].measurements.push({y:row,x,confidence:1});
    horizontal[row].measurements.push({x:column,y,confidence:1});samples.push({row,column,x,y});
  }
  return {samples,fit:options=>computeDistortion(vertical,horizontal,columnSeeds,rowSeeds,1,options)};
}
async function main(){
  const grouped=scene({grouped:true});const corrected=grouped.fit(),old=grouped.fit({clusterCorrection:false});
  assert.equal(corrected.referenceLattice.column.period,10);assert.equal(corrected.referenceLattice.row.period,10);
  assert.ok(corrected.measuredStats.p95<.08,JSON.stringify(corrected.measuredStats));
  assert.ok(old.measuredStats.p95>.9);
  const normal=scene().fit();assert.equal(normal.referenceLattice.column.period,null);assert.equal(normal.referenceLattice.row.period,null);
  const smooth=scene({curve:3}).fit();assert.equal(smooth.referenceLattice.column.period,null);assert.ok(smooth.decomposition.stats.nonlinear.p95>.5,'Must not erase true smooth distortion');
  const shear=scene({shear:.025,grouped:true}).fit(),plainShear=scene({shear:.025}).fit();
  assert.ok(shear.stats.p95>10,'True shear must remain');
  assert.ok(Math.abs(shear.stats.p95-plainShear.stats.p95)<.15);
  const ref=corrected.compensationModel.lattice;
  for(let c=-.4;c<60.4;c+=.07)assert.ok(Math.abs(indexAt(ref.columnCoordinates,coordinateAt(ref.columnCoordinates,c))-c)<1e-10);
  const sparse=grouped.samples.filter(p=>p.column<20&&p.row<20),missing=inferReference(sparse,20,20);
  assert.equal(missing.column.period,null,'Two blocks are insufficient');
  assert.equal(missing.row.period,null);
  const skipped=grouped.samples.map(p=>({...p,x:20+40*(p.column+Math.floor(p.column/10)),y:20+40*p.row}));
  assert.equal(inferReference(skipped,61,60).column.period,null,'Periodic missing columns must not become specimen gaps');
  // A grouped image with zero distortion is an identity mapping, not a
  // transformation that closes block gaps. Use a horizontal grayscale ramp.
  const model={lattice:{centerX:32,centerY:32,meanColumn:3,meanRow:3,c:8,d:0,
    columnCoordinates:[0,1,2,3,4.2,5.2,6.2],rowCoordinates:[0,1,2,3,4.2,5.2,6.2]},
    smooth:{columnCount:7,rowCount:7,dx:Array(10).fill(0),dy:Array(10).fill(0)}};
  assert.equal(evaluate(model,4,3).x,41.6);
  const raw=Buffer.from(Array.from({length:64*64},(_,i)=>(i%64)*3));
  const png=await sharp(raw,{raw:{width:64,height:64,channels:1}}).png().toBuffer();
  const out=await compensateImage(png,{compensationModel:model,image:{width:64,specimenHeight:64}});
  const pixels=await sharp(out.png).greyscale().raw().toBuffer();
  for(let x=12;x<55;x++)assert.equal(pixels[32*64+x],raw[32*64+x]);
  console.log('Repeated blocks removed from reference error; uniform grid, true shear/curvature, insufficient repeats and compensation gap preservation passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});

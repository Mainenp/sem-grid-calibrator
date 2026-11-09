const assert=require('node:assert/strict'),sharp=require('sharp');
const {analyze,computeDistortion}=require('./server');
const {inferReference}=require('./cluster-lattice');
const {compensateImage,compareCommonSupport,validateModel}=require('./full-compensation');
function scene(n,{boundary=true,curve=0,shear=0,mismatch=false,noise=0}={}){
 const coords=[0],seed=Array.from({length:n},(_,i)=>i);let random=24;
 for(let i=0;i<n-1;i++)coords.push(coords.at(-1)+1+(boundary?(i===2?.06:Math.abs(i-2)===1?-.03:0):0));
 const samples=[],vertical=seed.map(()=>({measurements:[]})),horizontal=seed.map(()=>({measurements:[]}));
 for(let row=0;row<n;row++)for(let column=0;column<n;column++){
  random=(1664525*random+1013904223)>>>0;const jitter=noise*(random/4294967296-.5);
  const x=40+100*(mismatch&&row>=n/2?column:coords[column])+curve*((column-(n-1)/2)/((n-1)/2))**3+shear*100*row+jitter,y=40+100*row;
  samples.push({column,row,x,y,confidence:1});vertical[column].measurements.push({x,y:row,confidence:1});horizontal[row].measurements.push({x:column,y,confidence:1});
 }
 return {samples,field:()=>computeDistortion(vertical,horizontal,seed,seed,1)};
}
async function main(){
 const six=scene(6).field();assert.equal(six.referenceLattice.column.status,'local-boundary');assert.equal(six.referenceLattice.column.period,null);
 assert.equal(six.referenceLattice.column.limitedSupport,true);assert.ok(six.measuredStats.p95<1e-5);
 const curved=scene(6,{boundary:false,curve:8}).field();assert.equal(curved.referenceLattice.column.status,'uniform');assert.ok(curved.stats.p95>1,'Narrow-view reference must retain real cubic curvature');
 const sheared=scene(6,{shear:.035}).field();assert.ok(sheared.stats.p95>5,'Do not absorb real shear into specimen spacing');
 assert.equal(inferReference(scene(6,{mismatch:true}).samples,6,6).column.status,'uniform');
 assert.equal(inferReference(scene(5).samples,5,5).column.status,'uniform','Four intervals cannot establish a local template');
 const noisy=scene(6,{boundary:false,noise:2}).field();assert.equal(noisy.referenceLattice.column.status,'uniform');

 // The rounded corners of a physically clipped square used to supply false
 // opposite edges. Keep complete near-edge objects, reject physical clipping.
 const n=384,rects=[];for(let y=12;y<n;y+=48)for(let x=12;x<n;x+=48)rects.push(`<rect x="${x-18}" y="${y-18}" width="36" height="36" rx="8" fill="#ccc"/>`);
 const png=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}"><rect width="100%" height="100%" fill="#222"/>${rects.join('')}</svg>`)).png().toBuffer();
 const measured=await analyze(png,{filename:'0.5kv-15875x-1K_synthetic.tif',fovMicrometers:8,normalizeOrientation:false,cacheResult:false,makeMask:false});
 assert.ok(measured.centers.filter(p=>p.x<30).every(p=>p.usedForFit===false),'Physically clipped centers cannot enter the fit');
 assert.ok(measured.centers.some(p=>p.usedForFit&&Math.abs(p.x-60)<1&&Math.abs(p.y-60)<1),'Complete nearby squares must stay measurable');

 // Output re-detection can renumber rows. Compare positions against a frozen
 // target, not the newly refitted lattice or a manufactured zero field.
 const model={lattice:{centerX:31.5,centerY:31.5,meanColumn:3,meanRow:3,c:8,d:0},smooth:{columnCount:7,rowCount:7,dx:Array(10).fill(0),dy:Array(10).fill(0)}};
 const before={compensationModel:model,measuredSamples:[]};
 for(let row=0;row<7;row++)for(let column=0;column<7;column++)before.measuredSamples.push({column,row,dx:.5,dy:0,x:8*column+8,y:8*row+7.5});
 const after=distance=>({image:{width:64,specimenHeight:64},centers:before.measuredSamples.map(p=>({column:p.column+2,row:p.row-1,x:7.5+8*p.column+distance,y:7.5+8*p.row,usedForFit:true})),distortion:{stats:{p95:0}}});
 const good=compareCommonSupport(before,after(.1));assert.equal(good.supported,true);assert.equal(good.matched,49);assert.equal(good.status,'improved');assert.ok(Math.abs(good.after.p95-.1)<1e-10);
 const bad=compareCommonSupport(before,after(1.5));assert.equal(bad.status,'worsened','A zero refitted field cannot hide wrong measured output centers');
 const missing=after(.1);missing.centers=missing.centers.filter(p=>p.y<30);assert.equal(compareCommonSupport(before,missing).supported,false);
 const duplicate=after(.1);duplicate.centers=duplicate.centers.flatMap(p=>[p,{...p}]);assert.equal(compareCommonSupport(before,duplicate).supported,false);
 assert.equal(compareCommonSupport({compensationModel:model},after(.1)).supported,false,'Legacy cached fields without measurements cannot claim matched validation');

 const ramp=await sharp(Buffer.from(Array.from({length:4096},(_,i)=>(i%64)*3)),{raw:{width:64,height:64,channels:1}}).png().toBuffer();
 await assert.rejects(()=>compensateImage(ramp,{compensationModel:model,image:{width:64,specimenHeight:64},stats:{p95:1},fitResidualStats:{p95:3}}),/residual/);
 const supported={...model,fitSupport:{minimumColumn:2,maximumColumn:4,minimumRow:2,maximumRow:4}};
 const result=await compensateImage(ramp,{compensationModel:supported,image:{width:64,specimenHeight:64}}),pixels=await sharp(result.png).greyscale().raw().toBuffer();
 assert.equal(pixels[32*64+32],96);assert.equal(pixels[10*64+10],0,'Do not extrapolate into unmeasured rows and columns');
 assert.throws(()=>validateModel({...model,fitSupport:{minimumColumn:-1,maximumColumn:4,minimumRow:2,maximumRow:4}}),/support/);
 console.log('PASS: narrow-view held-out/replicated boundary, preserved curvature/shear, physical clipping rejection, fixed-target common centers, missing/ambiguous support, unreliable-model refusal and bounded resampling');
}
main().catch(e=>{console.error(e);process.exitCode=1});

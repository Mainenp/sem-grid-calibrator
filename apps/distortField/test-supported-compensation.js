const assert=require('node:assert/strict'),sharp=require('sharp');
const {analyze,computeDistortion,server}=require('./server');
const {estimateOrientation,rotationTransform}=require('./grid-orientation');
const {compareCommonSupport}=require('./full-compensation');
const {inferReference}=require('./cluster-lattice');
function edgeScene(curve=0,mismatch=false){
 const n=10,offsets=Array.from({length:n-1},(_,i)=>i===0?.06:i===1?-.03:0),mean=offsets.reduce((a,b)=>a+b)/offsets.length,c=[0];
 for(const d of offsets)c.push(c.at(-1)+1+d-mean);
 const samples=[],vertical=c.map(()=>({measurements:[]})),horizontal=c.map(()=>({measurements:[]}));
 for(let row=0;row<n;row++)for(let column=0;column<n;column++){
  const x=50+80*(curve||mismatch&&row>=5?column:c[column])+curve*((column-4.5)/4.5)**3,y=50+80*row;
  samples.push({x,y,column,row,confidence:1});vertical[column].measurements.push({x,y:row,confidence:1});horizontal[row].measurements.push({x:column,y,confidence:1});
 }return {samples,field:()=>computeDistortion(vertical,horizontal,c.map((_,i)=>i),c.map((_,i)=>i),1)};
}
async function main(){
 const field=edgeScene().field();assert.equal(field.referenceLattice.column.edgeBoundary,true);assert.equal(field.referenceLattice.column.period,null);assert.ok(field.measuredStats.p95<.03);
 assert.equal(inferReference(edgeScene(9).samples,10,10).column.status,'uniform','Smooth curvature must survive an edge-boundary fit');
 assert.equal(inferReference(edgeScene(0,true).samples,10,10).column.status,'uniform','A specimen boundary must replicate in independent halves');
 // Small contrast and grain: the fallback needs agreement at two scales.
 const n=640,pitch=80,raw=Buffer.alloc(n*n);let random=71;
 for(let y=0;y<n;y++)for(let x=0;x<n;x++){
  const dx=Math.abs((x+40)%pitch-40),dy=Math.abs((y+40)%pitch-40),rx=Math.max(0,dx-21),ry=Math.max(0,dy-21);
  const inside=rx*rx+ry*ry<9*9;random=(1664525*random+1013904223)>>>0;
  raw[y*n+x]=Math.round((inside?180:145)+(random/4294967296-.5)*45);
 }
 const image=await sharp(raw,{raw:{width:n,height:n,channels:1}}).png().toBuffer();
 const shifted=await sharp(image).extend({top:30,bottom:30,left:30,right:30,background:'#000'}).png().toBuffer();
 const opts={filename:'21-tiltX0-tiltY0-skewX0-skewY0-0.tif',referenceScanWidth:n,fovMicrometers:8,makeMask:false,cacheResult:false};
 const framed=await analyze(shifted,opts);assert.match(framed.source.pitchPriorSource,/FOV/);assert.ok(framed.distortion.fitSampleCount>35,'Padding must not merge a low-contrast scan into one component');assert.ok(framed.quality.detectionRate>.8);
 const angle=30,rotated=await sharp(image).rotate(angle,{background:'#000'}).png().toBuffer(),meta=await sharp(rotated).metadata();
 const pose=await estimateOrientation(rotated,meta);assert.ok(pose.confidence>.25);assert.ok(Math.abs(pose.angleDegrees-angle)<3);
 const a=await analyze(rotated,{...opts,makeMask:true,cacheResult:true});assert.ok(a.analysis.orientationNormalization);assert.ok(a.quality.detectionRate>.8);assert.ok(a.distortion.fitSampleCount>35);
 const t=rotationTransform(n,n,angle,meta.width,meta.height),padX=Math.floor((meta.width-n)/2),padY=Math.floor((meta.height-n)/2),expected=[];
 for(let y=80;y<n-40;y+=pitch)for(let x=80;x<n-40;x+=pitch){const p=t.forward(x,y);expected.push({x:p.x+padX,y:p.y+padY});}
 const measured=a.centers.filter(p=>p.usedForFit),errors=expected.map(p=>Math.min(...measured.map(q=>Math.hypot(p.x-q.x,p.y-q.y)))).sort((x,y)=>x-y);
 assert.ok(errors[Math.floor(errors.length*.95)]<1.2,'Large-angle centers must map to the original pixel frame without scale/shear');
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/square-mask`);assert.equal(response.status,200);
  const {data,info}=await sharp(Buffer.from(await response.arrayBuffer())).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,meta.width);assert.equal(info.height,meta.height);
  const covered=measured.filter(p=>data[(Math.round(p.y)*info.width+Math.round(p.x))*4+3]>0).length;
  assert.ok(covered/measured.length>.95,'Large-angle displayed mask must remain aligned with original-frame centers');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 // Blank interior targets stay in the coverage denominator. External padding
 // alone is excluded; it cannot make genuine missing rows pass.
 const missing=Buffer.from(raw);for(let y=130;y<510;y++)for(let x=130;x<510;x++)missing[y*n+x]=145;
 const damaged=await analyze(await sharp(missing,{raw:{width:n,height:n,channels:1}}).png().toBuffer(),opts);
 assert.ok(damaged.quality.detectionRate<.85);assert.ok(damaged.quality.warnings.some(w=>w.includes('coverage')));
 const model={lattice:{centerX:24,centerY:31.5,meanColumn:3,meanRow:3,c:8,d:0},smooth:{columnCount:7,rowCount:7,dx:Array(10).fill(0),dy:Array(10).fill(0)}};
 const original={compensationModel:model,measuredSamples:[]},centers=[];
 for(let row=0;row<7;row++)for(let column=0;column<7;column++){const x=24+8*(column-3),y=31.5+8*(row-3);original.measuredSamples.push({column,row,dx:1,dy:0});if(x>=4)centers.push({x:x+.1,y,usedForFit:true});}
 const paired=compareCommonSupport(original,{image:{width:64,specimenHeight:64},centers});assert.equal(paired.supported,true);assert.equal(paired.excludedByOutputBoundary,7);assert.equal(paired.matched,42);assert.ok(paired.after.p95<.11);
 console.log('PASS: replicated cropped specimen boundary, preserved smooth curvature, noisy low-contrast large-angle original-frame centers, padding-only support and true interior missing-cell coverage, geometrically declared output eligibility');
}
main().catch(e=>{console.error(e);process.exitCode=1});

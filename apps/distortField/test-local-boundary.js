const assert=require('node:assert/strict');
const {computeDistortion}=require('./server');
const {inferReference}=require('./cluster-lattice');
const {paddingDistance}=require('./scan-support');
function scene({boundary=true,shear=0,curve=0,mismatch=false}={}){
 const n=12,coords=[0];for(let i=0;i<n-1;i++)coords.push(coords.at(-1)+1+(boundary?(i===5?.06:Math.abs(i-5)===1?-.03:0):0));
 const seeds=Array.from({length:n},(_,i)=>i),vertical=seeds.map(()=>({measurements:[]})),horizontal=seeds.map(()=>({measurements:[]})),samples=[];
 for(let row=0;row<n;row++)for(let column=0;column<n;column++){
  const x=20+100*(mismatch&&row>=6?column:coords[column])+shear*100*row+curve*((column-5.5)/5.5)**2,y=20+100*row;
  const p={column,row,x,y,confidence:1};samples.push(p);vertical[column].measurements.push({x,y:row,confidence:1});horizontal[row].measurements.push({x:column,y,confidence:1});
 }
 return {samples,field:()=>computeDistortion(vertical,horizontal,seeds,seeds,1)};
}
const grouped=scene().field();assert.equal(grouped.referenceLattice.column.status,'local-boundary');assert.equal(grouped.referenceLattice.column.period,null);
assert.ok(grouped.measuredStats.p95<.001);assert.ok(grouped.stats.p95<.001);
const uniform=scene({boundary:false,curve:8}).field();assert.equal(uniform.referenceLattice.column.status,'uniform');assert.ok(uniform.stats.p95>1);
const sheared=scene({shear:.035}).field();assert.equal(sheared.referenceLattice.column.status,'local-boundary');assert.ok(sheared.stats.p95>10,'Must preserve real shear');
assert.equal(inferReference(scene({mismatch:true}).samples,12,12).column.status,'uniform','Independent halves must agree');
const raw=Buffer.alloc(100*100,100);for(let y=0;y<20;y++)for(let x=0;x<100;x++)raw[y*100+x]=0;raw[50*100+50]=0;
const support=paddingDistance(raw,100,100);assert.equal(support[10*100+50],0);assert.ok(support[50*100+50]>10,'Interior dark holes are not scan padding');
console.log('Local boundary, unknown period, preserved shear/curvature, independent-subset rejection and external padding tests passed');

// The specimen may contain repeating blocks. Learn only a replicated,
// high-frequency interval template, never arbitrary per-row measured spacing.
const median=a=>{const s=a.slice().sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:NaN;};
function solve(matrix,vector){
  const a=matrix.map((r,i)=>[...r,vector[i]]),n=vector.length;
  for(let i=0;i<n;i++){
    let k=i;for(let j=i+1;j<n;j++)if(Math.abs(a[j][i])>Math.abs(a[k][i]))k=j;
    [a[i],a[k]]=[a[k],a[i]];const d=a[i][i];if(Math.abs(d)<1e-12)return Array(n).fill(0);
    for(let j=i;j<=n;j++)a[i][j]/=d;
    for(let r=0;r<n;r++)if(r!==i){const f=a[r][i];for(let j=i;j<=n;j++)a[r][j]-=f*a[i][j];}
  }return a.map(r=>r[n]);
}
function removeTrend(values){
  const normal=Array.from({length:3},()=>[0,0,0]),right=[0,0,0];
  values.forEach((v,i)=>{if(!Number.isFinite(v))return;const u=2*i/(values.length-1)-1,t=[1,u,u*u];
    for(let r=0;r<3;r++){right[r]+=t[r]*v;for(let c=0;c<3;c++)normal[r][c]+=t[r]*t[c];}});
  const fit=solve(normal,right);return values.map((v,i)=>{const u=2*i/(values.length-1)-1;return v-fit[0]-fit[1]*u-fit[2]*u*u;});
}
function template(values,period){
  const phase=Array.from({length:period},(_,j)=>median(values.filter((v,i)=>i%period===j&&Number.isFinite(v))));
  if(!phase.every(Number.isFinite))return null;
  const mean=phase.reduce((s,v)=>s+v,0)/period;return phase.map(v=>v-mean);
}
function detectAxis(samples,axis,count,otherCount){
  const uniform={status:'uniform',period:null,coordinates:Array.from({length:count},(_,i)=>i)};
  if(count<13)return detectLocalBoundary(samples,axis,count,otherCount)||{...uniform,reason:'too few repeated intervals'};
  const map=new Map(samples.filter(p=>(p.confidence??1)>=.25).map(p=>[`${p.column},${p.row}`,p]));
  const buckets=Array.from({length:count-1},()=>[]);
  for(const p of map.values()){
    const c=p.column+(axis==='column'?1:0),r=p.row+(axis==='row'?1:0),q=map.get(`${c},${r}`);
    if(q)buckets[p[axis]].push(Math.hypot(q.x-p.x,q.y-p.y));
  }
  const minimum=Math.max(6,Math.ceil(otherCount*.35));
  const gaps=buckets.map(b=>b.length>=minimum?median(b):NaN),valid=gaps.filter(Number.isFinite);
  if(valid.length<gaps.length*.8)return detectLocalBoundary(samples,axis,count,otherCount)||{...uniform,reason:'insufficient adjacent-center coverage'};
  const pitch=median(valid),normalized=gaps.map(v=>v/pitch),residual=removeTrend(normalized);
  const finite=residual.filter(Number.isFinite),abs=finite.map(Math.abs).sort((a,b)=>a-b);
  const cap=Math.max(.002,abs[Math.floor(abs.length*.9)]*2);
  const energy=arr=>arr.filter(Number.isFinite).reduce((s,v)=>s+Math.min(v*v,cap*cap),0);
  const base=energy(residual),noise=1.4826*median(finite.map(v=>Math.abs(v-median(finite))));
  let best=null;
  for(let period=3;period<=Math.min(32,Math.floor(valid.length/3));period++){
    // Require three observations of every phase, including at crop edges.
    if(Array.from({length:period},(_,j)=>residual.filter((v,i)=>i%period===j&&Number.isFinite(v)).length).some(n=>n<3))continue;
    const phase=template(residual,period);if(!phase)continue;
    // A missed row/column creates approximately double spacing. Do not
    // reinterpret such indexing failures as the reported slightly wider gap.
    if(phase.some(v=>1+v<.75||1+v>1.25))continue;
    const amplitude=Math.max(...phase)-Math.min(...phase);
    if(amplitude<Math.max(.008,noise*3)||Math.max(...phase)<.004)continue;
    const corrected=residual.map((v,i)=>v-phase[i%period]),gain=1-energy(corrected)/Math.max(base,1e-12);
    if(gain<.55)continue;
    // Independent alternating blocks must reproduce the phase template.
    const first=template(residual.map((v,i)=>Math.floor(i/period)%2===0?v:NaN),period);
    const second=template(residual.map((v,i)=>Math.floor(i/period)%2===1?v:NaN),period);
    if(!first||!second)continue;
    const disagreement=Math.sqrt(first.reduce((s,v,i)=>s+(v-second[i])**2,0)/period);
    if(disagreement>amplitude*.22)continue;
    const score=gain-.008*period;
    if(!best||score>best.score)best={period,phase,amplitude,gain,disagreement,score};
  }
  if(!best)return detectLocalBoundary(samples,axis,count,otherCount)||{...uniform,reason:'no stable replicated block pattern'};
  // Mean interval is one. This removes no mean-axis scale or smooth trend.
  const coordinates=[0];for(let i=0;i<count-1;i++)coordinates.push(coordinates.at(-1)+1+best.phase[i%best.period]);
  if(coordinates.some((v,i)=>i&&v<=coordinates[i-1]))return {...uniform,reason:'non-monotone template'};
  return {status:'grouped',period:best.period,coordinates,relativeIntervalOffsets:best.phase,
    intervalPeakToPeakPercent:100*best.amplitude,replicatedVarianceExplained:best.gain,
    crossBlockDisagreement:best.disagreement,adjacentPairCount:buckets.reduce((s,b)=>s+b.length,0)};
}
// A narrow view cannot establish a repeat period. It can still show one
// specimen block boundary: a wider interval flanked by two half-size losses.
// Fit that *zero-sum triplet*, not arbitrary measured spacing; require the
// same geometry in independent halves of the orthogonal axis. No period is
// invented and no mean scale or quadratic smooth distortion is removed.
function detectLocalBoundary(samples,axis,count,otherCount){
  if(count<6||otherCount<6)return null;
  const other=axis==='column'?'row':'column';
  const map=new Map(samples.filter(p=>(p.confidence??1)>=.25).map(p=>[`${p.column},${p.row}`,p]));
  const sets=[[],[],[]].map(()=>Array.from({length:count-1},()=>[]));
  for(const p of map.values()){
    const q=map.get(`${p.column+(axis==='column')},${p.row+(axis==='row')}`);if(!q)continue;
    const gap=Math.hypot(q.x-p.x,q.y-p.y),i=p[axis];sets[0][i].push(gap);sets[p[other]<otherCount/2?1:2][i].push(gap);
  }
  const gaps=sets.map((set,s)=>set.map(v=>v.length>=(s?3:6)?median(v):NaN));
  const supported=gaps[0].flatMap((v,i)=>Number.isFinite(v)?[i]:[]);
  // An expanded rotation canvas adds empty seed rows outside the specimen.
  // They are not missing *interior* intervals. Do not count this padding as
  // evidence against a boundary measured entirely inside the visible scan.
  if(supported.length<5||supported.length<(supported.at(-1)-supported[0]+1)*.8)return null;
  const limitedSupport=supported.length<7||otherCount<8;
  const pitch=median(gaps[0].filter(Number.isFinite));
  const fit=(values,peak)=>{
    // A five-interval view cannot stably cross-validate four free terms.
    // Reduce its background to a linear trend, retaining the quadratic-null
    // baseline below so smooth curvature alone cannot count as a boundary.
    const linearBackground=limitedSupport||peak===0||peak===count-2;
    const size=linearBackground?3:4,normal=Array.from({length:size},()=>Array(size).fill(0)),right=Array(size).fill(0);
    const terms=i=>{const u=2*i/(count-2)-1,s=i===peak?1:Math.abs(i-peak)===1?-.5:0;return linearBackground?[1,u,s]:[1,u,u*u,s];};
    values.forEach((v,i)=>{if(!Number.isFinite(v))return;const t=terms(i);
      for(let r=0;r<size;r++){right[r]+=t[r]*v/pitch;for(let c=0;c<size;c++)normal[r][c]+=t[r]*t[c];}});
    const b=solve(normal,right),errors=values.flatMap((v,i)=>Number.isFinite(v)?[v/pitch-terms(i).reduce((s,t,j)=>s+t*b[j],0)]:[]);
    return {amplitude:b.at(-1),noise:1.4826*median(errors.map(Math.abs)),energy:errors.reduce((s,v)=>s+v*v,0),coefficients:b,terms};
  };
  const base=removeTrend(gaps[0].map(v=>v/pitch)).filter(Number.isFinite).reduce((s,v)=>s+v*v,0);
  let best=null;
  for(let peak=0;peak<count-1;peak++){
    const edgeBoundary=peak===0||peak===count-2;
    if(edgeBoundary&&(supported.length<7||otherCount<8))continue;
    const required=[peak-1,peak,peak+1].filter(i=>i>=0&&i<count-1);
    if(gaps.some(v=>required.some(i=>!Number.isFinite(v[i]))))continue;
    const f=fit(gaps[0],peak),a=fit(gaps[1],peak),b=fit(gaps[2],peak),gain=1-f.energy/Math.max(base,1e-12);
    if(f.amplitude<Math.max(.02,6*f.noise)||f.amplitude>.15||gain<.85||Math.abs(a.amplitude-b.amplitude)>.2*f.amplitude||a.amplitude<=0||b.amplitude<=0)continue;
    let heldOutMaximum=0,amplitudeVariation=0;
    if(limitedSupport||edgeBoundary){
      // Six complete cells provide only five intervals. Accept this narrow
      // case only with stronger replication AND leave-one-interval-out tests.
      // Do not invent a global repeat period from this local observation.
      if(gain<.98||f.amplitude<10*f.noise||Math.abs(a.amplitude-b.amplitude)>.1*f.amplitude)continue;
      for(const missing of supported){
        const values=gaps[0].map((v,i)=>i===missing?NaN:v),omitted=fit(values,peak),t=omitted.terms(missing);
        const prediction=t.reduce((sum,v,i)=>sum+v*omitted.coefficients[i],0);
        heldOutMaximum=Math.max(heldOutMaximum,Math.abs(prediction-gaps[0][missing]/pitch));
        amplitudeVariation=Math.max(amplitudeVariation,Math.abs(omitted.amplitude-f.amplitude));
      }
      if(heldOutMaximum>Math.max(.002,.2*f.amplitude)||amplitudeVariation>.2*f.amplitude)continue;
    }
    if(!best||gain>best.gain)best={peak,...f,gain,edgeBoundary,disagreement:Math.abs(a.amplitude-b.amplitude),heldOutMaximum,amplitudeVariation};
  }
  if(!best)return null;
  const offsets=Array.from({length:count-1},(_,i)=>i===best.peak?best.amplitude:Math.abs(i-best.peak)===1?-best.amplitude*.5:0),coordinates=[0];
  // A cropped triplet can lose one outer half. Center the visible template
  // so the reference still cannot absorb mean axis magnification.
  const average=offsets.reduce((a,b)=>a+b,0)/offsets.length;
  for(let i=0;i<offsets.length;i++)offsets[i]-=average;
  for(const offset of offsets)coordinates.push(coordinates.at(-1)+1+offset);
  return {status:'local-boundary',period:null,coordinates,relativeIntervalOffsets:offsets,
    localBoundaryIndex:best.peak,edgeBoundary:best.edgeBoundary,replicatedVarianceExplained:best.gain,crossBlockDisagreement:best.disagreement,
    supportedIntervalCount:supported.length,limitedSupport,heldOutMaximumRelativeError:best.heldOutMaximum,
    heldOutAmplitudeVariation:best.amplitudeVariation,
    reason:'one zero-sum block-boundary triplet reproduced across independent row/column subsets; repeat period undetermined'};
}
function inferReference(samples,columnCount,rowCount){
  return {kind:'repeated-block square reference',
    column:detectAxis(samples,'column',columnCount,rowCount),row:detectAxis(samples,'row',rowCount,columnCount),
    assumption:'Replicated spacing pattern is specimen geometry, as reported by the user; imaging-periodic errors cannot be separated without independent target geometry.'};
}
function coordinateAt(coordinates,index){
  if(!coordinates)return index;
  const i=Math.max(0,Math.min(coordinates.length-2,Math.floor(index)));
  return coordinates[i]+(index-i)*(coordinates[i+1]-coordinates[i]);
}
function indexAt(coordinates,value){
  if(!coordinates)return value;
  let lo=0,hi=coordinates.length-1;
  while(hi-lo>1){const mid=(lo+hi)>>1;if(coordinates[mid]<=value)lo=mid;else hi=mid;}
  return lo+(value-coordinates[lo])/(coordinates[lo+1]-coordinates[lo]);
}
module.exports={inferReference,detectAxis,detectLocalBoundary,coordinateAt,indexAt};

// Matched-stratum associations, not causal attribution. Only change one recorded
// acquisition parameter at a time; never treat a batch label as elapsed time.
function median(values) {
  const s=values.slice().sort((a,b)=>a-b),n=s.length;
  return n?n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2:null;
}
function dependency(records,parameter,metric) {
  const controls=['batch','voltageKv','magnification','resolutionK','workingDistanceMm','minutesAfterCalibration'].filter(k=>k!==parameter && !(parameter==='acquisitionDay'&&k==='batch'));
  const groups=new Map();
  for(const r of records) {
    if(!Number.isFinite(r[parameter])||!Number.isFinite(r[metric])) continue;
    const key=controls.map(k=>`${k}:${r[k]??'not-recorded'}`).join('/');
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(r);
  }
  const strata=[];
  for(const [key,values] of groups) {
    const levels=[...new Set(values.map(r=>r[parameter]))].sort((a,b)=>a-b);
    if(levels.length<2) continue;
    const points=levels.map(x=>({x,y:median(values.filter(r=>r[parameter]===x).map(r=>r[metric])),
      count:values.filter(r=>r[parameter]===x).length}));
    const first=points[0],last=points.at(-1);
    const delta=last.y-first.y;
    const segmentSlopes=points.slice(1).map((p,i)=>(p.y-points[i].y)/(p.x-points[i].x));
    const increasing=segmentSlopes.some(s=>s>0),decreasing=segmentSlopes.some(s=>s<0);
    strata.push({key,points,delta,relativeChangePercent:first.y>1e-10?100*delta/first.y:null,
      slopePerUnit:delta/(last.x-first.x),
      segmentSlopes,observedTrend:increasing&&decreasing?'non-monotonic':increasing?'increasing':decreasing?'decreasing':'unchanged',
      trend:delta>0?'increasing':delta<0?'decreasing':'unchanged',
      shape:points.length<3?'two levels: linear/nonlinear is unidentifiable':'discrete trend: more levels/repeats required to identify linear/nonlinear dependence'});
  }
  return {parameter,metric,strata,matchedStrata:strata.length,
    medianEndpointRelativeChangePercent:median(strata.map(s=>s.relativeChangePercent).filter(Number.isFinite)),
    limitations:['Unrecorded acquisition conditions remain uncontrolled.','Endpoint changes are associations, not sensitivity coefficients or causal contributions.']};
}
module.exports={dependency,median};

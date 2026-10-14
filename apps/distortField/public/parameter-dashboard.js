'use strict';
const PARAMETERS={voltageKv:'电压（kV）',magnification:'倍率（×，PM所指采样率）',resolutionK:'分辨率（K）',acquisitionDay:'批次时间（距首批天数）'};
const METRICS={totalScanPercent:'总场',shearScanPercent:'剪切',differentialScaleScanPercent:'横纵尺度差',nonlinearScanPercent:'非线性',radialScanPercent:'径向',tangentialScanPercent:'切向',radialNm:'径向（nm）'};
const COLORS=['#1764b8','#c24145','#008477','#8055b3','#b56a10','#4b667a'];
const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=n=>Number.isFinite(n)?(Math.abs(n)<.001&&n!==0?n.toExponential(2):n.toFixed(4).replace(/0+$/,'').replace(/\.$/,'')):'—';
function groupLabel(key){return key.split('/').filter(s=>!s.endsWith('not-recorded')).map(s=>{
  const [k,v]=s.split(':');return k==='batch'?`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`:k==='voltageKv'?`${v} kV`:k==='magnification'?`${v}×`:k==='resolutionK'?`${v}K`:s;
}).join(' · ');}
function chartSvg(series,type,xLabel,yLabel){
  if(!series.length)return '<p class="muted">当前质量门槛下，没有匹配对照。</p>';
  const W=700,H=350,L=75,R=24,T=30,B=65;
  const xs=[...new Set(series.flatMap(s=>s.points.map(p=>p.x)))].sort((a,b)=>a-b);
  const max=Math.max(1e-9,...series.flatMap(s=>s.points.map(p=>p.y)))*1.15;
  const Y=y=>H-B-y/max*(H-T-B),slot=(W-L-R)/xs.length;
  // Line x positions preserve actual numeric spacing, unlike categorical bars.
  const X=x=>type==='bar'?L+(xs.indexOf(x)+.5)*slot:L+20+(x-xs[0])/Math.max(1e-9,xs.at(-1)-xs[0])*(W-L-R-40);
  const fullHeight=H+Math.ceil(series.length/2)*22+12;
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${fullHeight}" role="img" aria-label="${escapeHtml(xLabel+'与'+yLabel)}"><rect width="700" height="${fullHeight}" fill="white"/><g font-family="system-ui,Arial,sans-serif" font-size="12" fill="#40566b">`;
  for(let i=0;i<=4;i++){const y=max*i/4;svg+=`<path d="M${L} ${Y(y)}H${W-R}" stroke="#e2e9ef"/><text x="${L-10}" y="${Y(y)+4}" text-anchor="end">${number(y)}</text>`;}
  xs.forEach(x=>{svg+=`<text x="${X(x)}" y="${H-B+24}" text-anchor="middle">${number(x)}</text>`;});
  series.forEach((s,i)=>{
    const color=COLORS[i%COLORS.length];
    if(type==='line')svg+=`<polyline points="${s.points.map(p=>`${X(p.x)},${Y(p.y)}`).join(' ')}" stroke="${color}" stroke-width="2.5" fill="none"/>`;
    for(const p of s.points){const tip=escapeHtml(`${s.name}；${xLabel}=${p.x}；P95=${number(p.y)}；样本数=${p.count??'—'}`);
      if(type==='bar'){const bw=Math.min(40,slot*.75/series.length),x=X(p.x)+(i-series.length/2)*bw;svg+=`<rect x="${x}" y="${Y(p.y)}" width="${bw*.9}" height="${Math.max(0,H-B-Y(p.y))}" fill="${color}"><title>${tip}</title></rect>`;}
      else svg+=`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="4.5" fill="${color}"><title>${tip}</title></circle>`;
    }
  });
  svg+=`<text x="${(L+W-R)/2}" y="${H-10}" text-anchor="middle">${escapeHtml(xLabel)}</text><text transform="translate(16 ${H/2}) rotate(-90)" text-anchor="middle">${escapeHtml(yLabel)}</text>`;
  series.forEach((s,i)=>{const x=30+(i%2)*340,y=H+20+Math.floor(i/2)*22;svg+=`<circle cx="${x}" cy="${y-4}" r="4" fill="${COLORS[i%COLORS.length]}"/><text x="${x+10}" y="${y}" font-size="11">${escapeHtml(s.name)}</text>`;});
  return svg+'</g></svg>';
}
function overview(strata){
  const batches=new Map();
  for(const g of strata){const batch=g.key.split('/').find(s=>s.startsWith('batch:'))??'matched';if(!batches.has(batch))batches.set(batch,[]);batches.get(batch).push(g);}
  const selected=[];
  for(let i=0;selected.length<6;i++){let found=false;for(const values of batches.values()){if(values[i]&&selected.length<6){selected.push(values[i]);found=true;}}if(!found)break;}
  return selected;
}
async function start(){
  const response=await fetch('parameter-analysis-data.json',{cache:'no-store'});
  if(!response.ok)throw new Error('图表数据未生成，请运行 npm run dependencies:report');
  const data=await response.json();
  document.getElementById('included').textContent=data.included;
  document.getElementById('review').textContent=data.reviewExcluded;
  document.getElementById('failed').textContent=data.errorExcluded;
  document.getElementById('batches').textContent=new Set(data.records.map(r=>r.batch)).size;
  document.getElementById('snapshot').textContent=`图表数据：${data.source}；报告生成于${new Date(data.generatedAt).toLocaleString('zh-CN')}。当前为已生成的批量结果快照，不随单图上传自动更新。`;
  const metric=document.getElementById('metric'),type=document.getElementById('chartType');
  for(const [key,label] of Object.entries(METRICS)){const o=new Option(label,key);metric.add(o);}
  const cards=[];
  for(const [parameter,label] of Object.entries(PARAMETERS)){
    const card=document.createElement('article');card.className='card';
    card.innerHTML=`<h2>${escapeHtml(label)}</h2><div class="tools"><label>匹配条件<select aria-label="${escapeHtml(label)}匹配组"></select></label><button type="button">下载 SVG</button></div><div class="chart"></div><div class="legend"></div><p class="note"></p><details><summary>查看对应数据</summary><div class="table-scroll"></div></details>`;
    document.getElementById('charts').append(card);
    const select=card.querySelector('select');
    select.add(new Option('概览（最多6个匹配组）','all'));
    const groups=data.analyses.find(a=>a.parameter===parameter&&a.metric==='totalScanPercent').strata;
    groups.forEach((g,i)=>select.add(new Option(groupLabel(g.key),String(i))));
    const update=()=>{
      const a=data.analyses.find(a=>a.parameter===parameter&&a.metric===metric.value);
      const selected=select.value==='all'?overview(a.strata):[a.strata[Number(select.value)]].filter(Boolean);
      const series=selected.map(g=>({name:groupLabel(g.key),points:g.points}));
      const unit=metric.value==='radialNm'?'P95（nm；查看标尺来源）':'P95 / 原扫描宽度（%）';
      card.querySelector('.chart').innerHTML=chartSvg(series,type.value,label,unit);
      card.querySelector('.legend').textContent='';
      card.querySelector('.note').textContent=`共有${a.strata.length}个匹配组，当前显示${selected.length}组。${parameter==='acquisitionDay'?'仅两个批次日期；差异包含校准、视野等变化，不等于时间的单独作用。':'固定批次和其他已记录条件，仅连接实际测量水平；未记录条件仍可能混杂。'}将鼠标放在点或柱上可查看数值。`;
      card.querySelector('.table-scroll').innerHTML='<table><thead><tr><th>固定条件</th><th>参量</th><th>P95</th><th>样本数</th></tr></thead><tbody>'+selected.flatMap(g=>g.points.map(p=>`<tr><td>${escapeHtml(groupLabel(g.key))}</td><td>${p.x}</td><td>${number(p.y)}</td><td>${p.count}</td></tr>`)).join('')+'</tbody></table>';
    };
    select.onchange=update;
    card.querySelector('button').onclick=()=>{const svg=card.querySelector('svg');if(!svg)return;download(new Blob([svg.outerHTML],{type:'image/svg+xml'}),`${parameter}-${metric.value}-${type.value}.svg`);};
    cards.push(update);update();
  }
  metric.onchange=type.onchange=()=>cards.forEach(update=>update());
  const full=data.compensation;
  if(full){
    const series=[['原图',full.before],['完整补偿后重新检测',full.after]].map(([name,d])=>({name,points:[{x:0,y:d.stats.p95},{x:1,y:d.measuredStats.p95},{x:2,y:d.residual.p95}]}));
    document.getElementById('compensationChart').innerHTML=chartSvg(series,'bar','0 平滑总场 · 1 实测中心偏差 · 2 场残差','P95（px）');
    document.getElementById('compensationCaption').textContent=`蓝色为原图，红色为补偿后。平滑总场${full.before.stats.p95.toFixed(3)} → ${full.after.stats.p95.toFixed(3)} px；实测中心偏差仍为${full.after.measuredStats.p95.toFixed(3)} px。质量${full.after.quality.status}，有效像素${(full.validFraction*100).toFixed(1)}%。同图重新检测是内部一致性验证，不代表独立物理精度。`;
  }else document.getElementById('compensation').hidden=true;
  document.getElementById('downloadData').onclick=()=>download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),'parameter-analysis.json');
}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
start().catch(e=>{const box=document.getElementById('error');box.hidden=false;box.textContent=e.message;});

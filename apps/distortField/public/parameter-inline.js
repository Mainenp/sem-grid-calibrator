(() => {
  'use strict';
  const parameters={voltageKv:'电压 / kV',magnification:'倍率 / ×',resolutionK:'分辨率 / K',acquisitionDay:'批次时间 / 距首批天数'};
  const metrics={totalScanPercent:'总场',shearScanPercent:'剪切',differentialScaleScanPercent:'横纵尺度差',nonlinearScanPercent:'非线性',radialScanPercent:'径向',tangentialScanPercent:'切向'};
  // Colour-blind-friendly scientific palette; symbols also identify modes.
  const tones=['#222222','#0072b2','#d55e00','#009e73','#cc79a7','#b77900'];
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const format=n=>n===0?'0':Math.abs(n)<.001?n.toExponential(1):Number(n.toPrecision(3)).toString();
  function marker(index,x,y,color,r=3.6){
    const style=`fill="white" stroke="${color}" stroke-width="1.4"`;
    if(index===1)return `<rect x="${x-r}" y="${y-r}" width="${2*r}" height="${2*r}" ${style}/>`;
    if(index===2)return `<path d="M${x} ${y-r-1}L${x+r+1} ${y+r}H${x-r-1}Z" ${style}/>`;
    if(index===3)return `<path d="M${x} ${y-r-1}L${x+r+1} ${y}L${x} ${y+r+1}L${x-r-1} ${y}Z" ${style}/>`;
    if(index===4)return `<path d="M${x-r-1} ${y}H${x+r+1}M${x} ${y-r-1}V${y+r+1}" fill="none" stroke="${color}" stroke-width="1.7"/>`;
    if(index===5)return `<path d="M${x-r} ${y-r}L${x+r} ${y+r}M${x-r} ${y+r}L${x+r} ${y-r}" fill="none" stroke="${color}" stroke-width="1.7"/>`;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`;
  }
  function groupsFor(data,parameter){
    const base=data.analyses.find(a=>a.parameter===parameter&&a.metric==='totalScanPercent');
    return (base?.strata??[]).filter(g=>g.points.length>=2).sort((a,b)=>b.points.length-a.points.length||a.key.localeCompare(b.key));
  }
  function groupLabel(key){
    const labels={batch:'批次',voltageKv:'kV',magnification:'×',resolutionK:'K'};
    return key.split('/').filter(p=>!p.includes('not-recorded')).map(p=>{
      const [name,value]=p.split(':');
      return name==='batch'?`${value.slice(0,4)}.${value.slice(4,6)}.${value.slice(6,8)}`:`${value}${labels[name]??name}`;
    }).join(' · ');
  }
  function svgFor(data,parameter,key,id){
    const groups=Object.keys(metrics).flatMap((metric,index)=>{
      const group=data.analyses.find(a=>a.parameter===parameter&&a.metric===metric)?.strata.find(g=>g.key===key);
      if(!group)return [];
      const points=group.points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)).sort((a,b)=>a.x-b.x);
      return points.length>=2?[{metric,index,points}]:[];
    });
    if(!groups.length)return '<div class="dependency-empty" role="img" aria-label="缺少匹配数据">∅</div>';
    const W=660,H=390,L=88,R=32,T=30,B=74;
    const values=groups.flatMap(g=>g.points);
    const xs=[...new Set(values.map(p=>p.x))].sort((a,b)=>a-b);
    const rawMaximum=Math.max(1e-10,...values.map(p=>p.y))*1.12;
    const stepScale=10**Math.floor(Math.log10(rawMaximum/4)),scaled=rawMaximum/4/stepScale;
    const step=([1,2,2.5,5,10].find(n=>n>=scaled)||10)*stepScale;
    const maximum=Math.ceil(rawMaximum/step)*step;
    const X=x=>L+(x-xs[0])/Math.max(1e-10,xs.at(-1)-xs[0])*(W-L-R);
    const Y=y=>H-B-y/maximum*(H-T-B);
    const xLabel=parameters[parameter],yLabel='P95 (扫描宽度 %)';
    let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(xLabel+'与各畸变分量'+yLabel)}"><rect width="${W}" height="${H}" fill="white"/><g font-family="Arial,Helvetica,system-ui,sans-serif" font-size="13" fill="#222">`;
    svg+=`<path d="M${L} ${T}V${H-B}H${W-R}" fill="none" stroke="#222" stroke-width="1.1"/>`;
    for(let i=0;i<=Math.round(maximum/step);i++){
      const y=step*i;
      svg+=`<path d="M${L-5} ${Y(y)}H${L}" stroke="#222" stroke-width="1.1"/><text x="${L-12}" y="${Y(y)+4}" text-anchor="end">${format(y)}</text>`;
    }
    for(const x of xs)svg+=`<path d="M${X(x)} ${H-B}v5" stroke="#222" stroke-width="1.1"/><text x="${X(x)}" y="${H-B+25}" text-anchor="middle">${format(x)}</text>`;
    // Render total last so the primary curve remains visible at crossings.
    [...groups].sort((a,b)=>b.index-a.index).forEach(g=>{
      const color=tones[g.index],points=g.points.map(p=>`${X(p.x)},${Y(p.y)}`).join(' '),total=g.index===0;
      svg+=`<polyline data-metric="${g.metric}" points="${points}" stroke="${color}" stroke-width="${total?'2.2':'1.6'}" fill="none" stroke-linejoin="round"/>`;
      for(const p of g.points)svg+=marker(g.index,X(p.x),Y(p.y),color,total?4:3.6);
    });
    return svg+`<text x="${(L+W-R)/2}" y="${H-17}" text-anchor="middle" font-size="15">${escape(xLabel)}</text><text transform="translate(26 ${(T+H-B)/2}) rotate(-90)" text-anchor="middle" font-size="15">${escape(yLabel)}</text></g></svg>`;
  }
  const toggle=document.getElementById('dependencyToggle'),panel=document.getElementById('dependencyPanel');
  const grid=document.getElementById('dependencyCharts');
  let loaded=false,loading=false;
  function open(value){
    panel.hidden=!value;document.querySelector('main').classList.toggle('dependency-open',value);
    toggle.setAttribute('aria-expanded',String(value));toggle.textContent=value?'收起参数依赖图表':'展开参数依赖图表';
    if(value&&!loaded&&!loading)load();
    if(!value)toggle.focus();
  }
  async function load(){
    loading=true;grid.innerHTML='<div class="dependency-loading" role="status" aria-label="加载图表"></div>';
    try{
      const response=await fetch('parameter-analysis-data.json',{cache:'no-store'});
      if(!response.ok)throw new Error('Chart data unavailable');
      const data=await response.json();
      grid.replaceChildren();let id=0;
      for(const parameter of Object.keys(parameters)){
        const article=document.createElement('article');article.className='dependency-chart';
        const groups=groupsFor(data,parameter),chartId=id++;
        const controls=document.createElement('div');controls.className='dependency-chart-controls';
        const select=document.createElement('select');select.setAttribute('aria-label',`${parameters[parameter]}匹配条件`);
        for(const group of groups){const option=document.createElement('option');option.value=group.key;option.textContent=groupLabel(group.key);select.append(option);}
        select.disabled=!groups.length;controls.append(select);
        const plot=document.createElement('div');
        const render=()=>{plot.innerHTML=svgFor(data,parameter,select.value,chartId);};
        select.onchange=render;render();article.append(controls,plot);grid.append(article);
      }
      const legend=document.createElement('div');legend.className='dependency-modes';legend.setAttribute('aria-label','曲线颜色');
      Object.values(metrics).forEach((label,index)=>{const item=document.createElement('span');const swatch=document.createElement('i');swatch.innerHTML=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 16"><path d="M0 8H32" stroke="${tones[index]}" stroke-width="1.6"/>${marker(index,16,8,tones[index],3)}</svg>`;item.append(swatch,document.createTextNode(label));legend.append(item);});
      grid.prepend(legend);
      loaded=true;
    }catch(error){grid.innerHTML='<div class="dependency-empty" role="alert" aria-label="图表加载失败，收起后重新展开可重试">⚠</div>';console.error(error);}
    finally{loading=false;}
  }
  toggle.onclick=()=>open(panel.hidden);
  document.getElementById('dependencyClose').onclick=()=>open(false);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden)open(false);});
})();

(() => {
  'use strict';
  const parameters={voltageKv:'电压 / kV',magnification:'倍率 / ×',resolutionK:'分辨率 / K',acquisitionDay:'批次时间 / 距首批天数'};
  const metrics={totalScanPercent:'总场',shearScanPercent:'剪切',differentialScaleScanPercent:'横纵尺度差',nonlinearScanPercent:'非线性',radialScanPercent:'径向',tangentialScanPercent:'切向'};
  const tones=['#e4efff','#5ddac4','#81aaff','#baa0f4','#edb881','#df879e'];
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const format=n=>n===0?'0':Math.abs(n)<.001?n.toExponential(1):Number(n.toPrecision(3)).toString();
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
    const W=660,H=370,L=78,R=32,T=28,B=68;
    const values=groups.flatMap(g=>g.points);
    const xs=[...new Set(values.map(p=>p.x))].sort((a,b)=>a-b);
    const maximum=Math.max(1e-10,...values.map(p=>p.y))*1.12;
    const X=x=>L+(x-xs[0])/Math.max(1e-10,xs.at(-1)-xs[0])*(W-L-R);
    const Y=y=>H-B-y/maximum*(H-T-B);
    const xLabel=parameters[parameter],yLabel='P95 / 扫描宽度 %';
    let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(xLabel+'与各畸变分量'+yLabel)}"><defs><linearGradient id="wash-${id}" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#b9d7ff" stop-opacity=".1"/><stop offset="1" stop-color="#b9d7ff" stop-opacity="0"/></linearGradient></defs><g font-family="Inter,system-ui,Arial,sans-serif" font-size="11" fill="#8ca4b7">`;
    for(let i=0;i<=4;i++){
      const y=maximum*i/4;
      svg+=`<path d="M${L} ${Y(y)}H${W-R}" stroke="#8ca4b7" stroke-opacity="${i===0?'.18':'.075'}"/><text x="${L-13}" y="${Y(y)+4}" text-anchor="end">${format(y)}</text>`;
    }
    for(const x of xs)svg+=`<path d="M${X(x)} ${T}V${H-B}" stroke="#8ca4b7" stroke-opacity=".05" stroke-dasharray="2 6"/><text x="${X(x)}" y="${H-B+25}" text-anchor="middle">${format(x)}</text>`;
    // Render total last so the primary curve remains visible at crossings.
    [...groups].sort((a,b)=>b.index-a.index).forEach(g=>{
      const color=tones[g.index],points=g.points.map(p=>`${X(p.x)},${Y(p.y)}`).join(' '),total=g.index===0;
      if(total)svg+=`<path d="M${X(g.points[0].x)} ${H-B} L${points.replaceAll(' ', ' L')} L${X(g.points.at(-1).x)} ${H-B} Z" fill="url(#wash-${id})"/>`;
      svg+=`<polyline data-metric="${g.metric}" points="${points}" stroke="${color}" stroke-width="${total?'2.8':'1.7'}" stroke-opacity="${total?'1':'.85'}" fill="none" stroke-linejoin="round"/>`;
      for(const p of g.points)svg+=`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${total?'4':'3'}" fill="#0e1722" stroke="${color}" stroke-width="${total?'2':'1.5'}"/>`;
    });
    return svg+`<text x="${(L+W-R)/2}" y="${H-17}" text-anchor="middle" font-size="12" fill="#b0c4d2">${escape(xLabel)}</text><text transform="translate(23 ${(T+H-B)/2}) rotate(-90)" text-anchor="middle" font-size="12" fill="#b0c4d2">${escape(yLabel)}</text></g></svg>`;
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
      Object.values(metrics).forEach((label,index)=>{const item=document.createElement('span');const swatch=document.createElement('i');swatch.style.background=tones[index];item.append(swatch,document.createTextNode(label));legend.append(item);});
      grid.prepend(legend);
      loaded=true;
    }catch(error){grid.innerHTML='<div class="dependency-empty" role="alert" aria-label="图表加载失败，收起后重新展开可重试">⚠</div>';console.error(error);}
    finally{loading=false;}
  }
  toggle.onclick=()=>open(panel.hidden);
  document.getElementById('dependencyClose').onclick=()=>open(false);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden)open(false);});
})();

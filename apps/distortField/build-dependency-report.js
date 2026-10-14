const fs=require('fs'),path=require('path'),sharp=require('sharp');
const {dependency}=require('./parameter-dependencies');
const OUT=path.resolve(process.argv[2]||path.join(__dirname,'results','2026-10-09-orthogonal-test'));
const metadataFile=process.argv[3];
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=['#1565c0','#c62828','#00897b','#8e24aa','#ed6c02','#5d4037'];
function svgChart(title,series,xLabel,yLabel,category=false) {
  const W=1000,H=460,L=100,T=65,R=category?95:35,B=120;
  const xs=series.flatMap(s=>s.points.map(p=>p.x)),ys=series.flatMap(s=>s.points.map(p=>p.y));
  const x0=category?0:Math.min(...xs),x1=Math.max(...xs),y1=Math.max(.000001,...ys)*1.12;
  const X=x=>L+(x-x0)/Math.max(1e-9,x1-x0)*(W-L-R),Y=y=>H-B-y/y1*(H-T-B);
  let s=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="white"/><g font-family="Arial Unicode MS,Arial" fill="#222"><text x="${L}" y="30" font-size="22">${escape(title)}</text>`;
  for(let i=0;i<=4;i++){const y=y1*i/4;s+=`<path d="M${L} ${Y(y)}H${W-R}" stroke="#e5e7eb"/><text x="${L-12}" y="${Y(y)+5}" text-anchor="end" font-size="14">${y.toPrecision(3)}</text>`;}
  const unique=[...new Set(xs)].sort((a,b)=>a-b);
  for(const x of unique)s+=`<text x="${X(x)}" y="${H-B+26}" text-anchor="middle" font-size="14">${category?['第一批原图','第一批仅正交补偿','第二批原图'][x]:x}</text>`;
  series.forEach((line,i)=>{
    const color=colors[i%colors.length];
    s+=`<polyline points="${line.points.map(p=>`${X(p.x)},${Y(p.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
    line.points.forEach(p=>{s+=`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="4" fill="${color}"/>`;});
    s+=`<text x="${L+(i%3)*290}" y="${H-20-Math.floor(i/3)*20}" font-size="12" fill="${color}">${escape(line.name)}</text>`;
  });
  s+=`<text x="${(L+W-R)/2}" y="${H-B+53}" text-anchor="middle" font-size="16">${escape(xLabel)}</text><text transform="translate(25 ${H/2}) rotate(-90)" text-anchor="middle" font-size="16">${escape(yLabel)}</text></g></svg>`;
  return s;
}
async function main() {
  fs.mkdirSync(OUT,{recursive:true});
  const data=JSON.parse(fs.readFileSync(path.join(__dirname,'results','2026-10-08-modes','paired-modes.json'),'utf8'));
  const supplied=metadataFile?JSON.parse(fs.readFileSync(metadataFile,'utf8')):[];
  if(!Array.isArray(supplied)) throw new Error('Metadata must be an array of records');
  const known=new Set(data.records.map(r=>`${r.batch}/${r.filename}`)),seen=new Set();
  for(const m of supplied) {
    const key=`${m.batch}/${m.filename}`;
    if(!known.has(key)||seen.has(key)) throw new Error(`Unknown or duplicate metadata record: ${key}`);
    seen.add(key);
    for(const k of ['fovMicrometers','workingDistanceMm','minutesAfterCalibration']) {
      if(m[k]!=null && (!Number.isFinite(m[k])||(k==='minutesAfterCalibration'?m[k]<0:m[k]<=0))) throw new Error(`Invalid ${k} for ${key}`);
    }
  }
  const metadata=new Map(supplied.map(m=>[`${m.batch}/${m.filename}`,m]));
  const batchEpoch=batch=>/^\d{8}$/.test(String(batch))?Date.UTC(Number(String(batch).slice(0,4)),Number(String(batch).slice(4,6))-1,Number(String(batch).slice(6,8)))/86400000:null;
  const firstDay=Math.min(...data.records.map(r=>batchEpoch(r.batch)).filter(Number.isFinite));
  const records=data.records.filter(r=>r.quality!=='error').map(r=>{
    const [voltageKv,magnification,resolutionK]=r.key.split('/').map(Number),m=metadata.get(`${r.batch}/${r.filename}`)||{};
    const fov=m.fovMicrometers??127000/magnification;
    return {...r,voltageKv,magnification,resolutionK,acquisitionDay:batchEpoch(r.batch)==null?null:batchEpoch(r.batch)-firstDay,
      timeSource:'batch folder date only; not calibration elapsed time',
      workingDistanceMm:m.workingDistanceMm??null,minutesAfterCalibration:m.minutesAfterCalibration??null,
      fovMicrometers:fov,physicalScaleSource:m.fovMicrometers!=null?'user-supplied FOV':'estimated from magnification',
      totalScanPercent:100*r.total.p95/r.width,radialScanPercent:100*r.modes.radial.p95/r.width,
      nonlinearScanPercent:100*r.modes.nonlinear.p95/r.width,radialNm:r.modes.radial.p95*fov*1000/r.width,
      shearScanPercent:100*r.affineModes.shear.p95/r.width,
      differentialScaleScanPercent:100*r.affineModes.differentialScale.p95/r.width,
      tangentialScanPercent:100*r.modes.tangential.p95/r.width};
  });
  // Use current quality gates, not the old CSV's originalQuality.
  const accepted=records.filter(r=>r.quality==='ok');
  const parameters=['voltageKv','magnification','resolutionK','acquisitionDay'];
  const metrics=['totalScanPercent','radialScanPercent','nonlinearScanPercent','radialNm','shearScanPercent','differentialScaleScanPercent','tangentialScanPercent'];
  const analyses=parameters.flatMap(parameter=>metrics.map(metric=>dependency(accepted,parameter,metric)));
  fs.writeFileSync(path.join(OUT,'parameter-dependencies.json'),JSON.stringify({source:'2026-10-08 same-code reanalysis cache; unit conversions added, fit unchanged',
    included:accepted.length,reviewExcluded:records.length-accepted.length,records,analyses},null,2));
  const template=data.records.map(r=>({batch:r.batch,filename:r.filename,fovMicrometers:null,workingDistanceMm:null,minutesAfterCalibration:null}));
  fs.writeFileSync(path.join(OUT,'acquisition-metadata-template.json'),JSON.stringify(template,null,2));
  const pair=JSON.parse(fs.readFileSync(path.join(OUT,'comparison.json'),'utf8'));
  const old=pair.records[0],fixed=pair.records[1],redetected=pair.records[2],recent=pair.records[3];
  const comparison=svgChart('单对图像：仅正交补偿后的P95',[...['total','shear','differentialScale','nonlinear','radial'].map((mode,i)=>({name:{total:'总场',shear:'剪切',differentialScale:'横纵尺度差',nonlinear:'非线性',radial:'径向'}[mode],
    points:[old,fixed,recent].map((r,x)=>({x,y:(mode==='total'?r.units.total:r.units.modes[mode]).scanPercent.p95}))}))],'相同采集参数，非完全相同视野','P95 / 扫描宽度 (%)',true);
  await sharp(Buffer.from(comparison)).png().toFile(path.join(OUT,'orthogonal-comparison.png'));
  const names={voltageKv:'电压 (kV)',magnification:'倍率（PM所指采样率，×）',resolutionK:'分辨率 (K)',acquisitionDay:'批次时间（距首批天数）'};
  let sections='';
  for(const parameter of parameters) {
    const a=analyses.find(a=>a.parameter===parameter&&a.metric==='radialScanPercent');
    const groups=a.strata;
    sections+=`<h2>${names[parameter]}与径向分量</h2>`;
    if(!groups.length){sections+=`<p>没有可用的同条件配对数据。${parameter==='minutesAfterCalibration'?'两批日期不等于校准后时间，不能据此评估漂移。':parameter==='workingDistanceMm'?'仅已知示例图工作距离，同时批次也变化，不能独立估计工作距离效应。':'当前质量门槛下，没有只改变此参量的合格配对。'}</p>`;continue;}
    const byBatch=new Map();
    for(const g of groups){const batch=g.key.split('/')[0];if(!byBatch.has(batch))byBatch.set(batch,[]);byBatch.get(batch).push(g);}
    const selected=[...byBatch.values()].flatMap(gs=>gs.slice(0,byBatch.size>1?3:6));
    const series=selected.map(g=>({name:g.key.split('/').filter(v=>!v.endsWith('not-recorded')).map(v=>{
      const [k,value]=v.split(':');return k==='batch'?`${value.slice(4,6)}/${value.slice(6)}`:k==='voltageKv'?`${value}kV`:k==='magnification'?`${value}×`:k==='resolutionK'?`${value}K`:`${k}=${value}`;
    }).join(' · '),points:g.points}));
    const chart=svgChart(`${names[parameter]} → 径向P95`,series,names[parameter],'径向P95 / 扫描宽度 (%)');
    await sharp(Buffer.from(chart)).png().toFile(path.join(OUT,`${parameter}-radial.png`));
    sections+=chart+`<p>${groups.length}个匹配组。${parameter==='acquisitionDay'?'固定文件名中的电压、倍率和分辨率，比较两批日期；不能把批次差异单独归因为时间。':'固定批次及其他已记录条件，改变当前参量。'}仅连接实际观测值，未做曲线外推。图中最多展示6组；小幅mode可能低于拟合残差，径向幅度不是已标定的桶形误差真值。</p>`;
    sections+='<table><tr><th>固定条件</th><th>参量起点 → 终点</th><th>径向分量相对变化</th><th>趋势判断</th></tr>';
    groups.forEach(g=>{sections+=`<tr><td>${escape(g.key)}</td><td>${g.points[0].x} → ${g.points.at(-1).x}</td><td>${g.relativeChangePercent==null?'不可用':g.relativeChangePercent.toFixed(1)+'%'}</td><td>${{'non-monotonic':'实测非单调','increasing':'实测递增','decreasing':'实测递减','unchanged':'实测不变'}[g.observedTrend]}。${g.points.length<3?'仅两水平，无法区分线性/非线性':'离散趋势，缺少重复实验'}</td></tr>`;});
    sections+='</table><p>相对变化=（终点−起点）/起点；基线很小时百分比容易放大，必须同时看绝对幅度和拟合残差。径向分量混合了桶形、枕形，不能把径向幅度增加直接称为“桶形增加”。</p>';
    for(const [metric,label,unit] of [['totalScanPercent','总场','% scan'],['nonlinearScanPercent','非线性','% scan'],['shearScanPercent','剪切','% scan'],['differentialScaleScanPercent','横纵尺度差','% scan'],['tangentialScanPercent','切向','% scan'],['radialNm','径向','nm（部分按倍率估算）']]) {
      const other=analyses.find(a=>a.parameter===parameter&&a.metric===metric);
      const extra=svgChart(`${names[parameter]} → ${label}P95`,selected.map(g=>{
        const match=other.strata.find(s=>s.key===g.key);
        return {name:series[selected.indexOf(g)].name,points:match.points};
      }),names[parameter],`${label}P95 (${unit})`);
      await sharp(Buffer.from(extra)).png().toFile(path.join(OUT,`${parameter}-${metric}.png`));
      sections+=`<details><summary>查看${label}P95 (${unit})</summary>${extra}</details>`;
    }
  }
  const labels={'first-original':'第一批原图','first-angle-only-fixed-centers':'第一批补偿（固定中心）','first-angle-only-redetected':'第一批补偿（重新检测）','second-original':'第二批原图'};
  const rows=pair.records.map(r=>`<tr><td>${labels[r.label]}</td><td>${r.angleDeg.toFixed(5)}</td><td>${r.stats.p95.toFixed(3)}</td><td>${r.units.total.scanPercent.p95.toFixed(4)}</td><td>${r.units.total.nm.p95.toFixed(1)}</td><td>${r.modes.nonlinear.p95.toFixed(3)}</td><td>${r.residual.p95.toFixed(3)}</td><td>${r.quality.status==='ok'?'通过':'需复核'}</td></tr>`).join('');
  const percent=100*(old.stats.p95-fixed.stats.p95)/(old.stats.p95-recent.stats.p95);
  const validationFile=path.join(__dirname,'results','2026-10-10-full-compensation-26-supported','validation.json');
  const full=fs.existsSync(validationFile)?JSON.parse(fs.readFileSync(validationFile,'utf8')):null;
  const fullSection=full?`<h2>新增 完整补偿及重新检测验证</h2><p>2026年10月10日按新的要求，第一批26号采用完整的平方晶格与三次位移场进行逆向重采样，同时补偿旋转、剪切、横纵尺度差和平滑非线性形变。不是把已有位移数值直接设为零。</p><table><tr><th>指标</th><th>原图</th><th>完整补偿后重新检测</th></tr><tr><td>平滑总场P95 px</td><td>${full.before.stats.p95.toFixed(3)}</td><td>${full.after.stats.p95.toFixed(3)}</td></tr><tr><td>实测中心偏差P95 px</td><td>${full.before.measuredStats.p95.toFixed(3)}</td><td>${full.after.measuredStats.p95.toFixed(3)}</td></tr><tr><td>中心到平滑场的残差P95 px</td><td>${full.before.residual.p95.toFixed(3)}</td><td>${full.after.residual.p95.toFixed(3)}</td></tr><tr><td>质量状态</td><td>${full.before.quality.status}</td><td>${full.after.quality.status}</td></tr></table><p>补偿后夹角${full.after.includedAngleDeg.toFixed(5)}°，有效像素${(full.validFraction*100).toFixed(1)}%。平滑场接近0说明本图的可拟合系统形变大幅减少；实测中心误差仍非零。黑边不参加“成功”解释，补偿后review保留：${escape(full.after.quality.warnings.join('; '))}。原图拟合再验证属于同图一致性检验，不能证明绝对物理精度或跨图补偿泛化能力。</p>`:'';
  const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><title>正交补偿与参数依赖测试</title><style>body{font:16px/1.65 Arial,'PingFang SC',sans-serif;color:#222;max-width:1100px;margin:32px auto;padding:0 24px}h1{font-size:28px}h2{margin-top:36px;font-size:22px}svg,img{width:100%;height:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left;overflow-wrap:anywhere}th{background:#edf0f3}small{color:#555}</style><h1>正交补偿与参数依赖测试</h1><p>2026年10月9日。第一批26号、第二批29号，均为10 kV / 2000倍 / 8K。工作距离分别为2.59和3.60 mm，图上FOV分别63.48和63.50 µm，不属于完全受控的同视野实验。</p>
    <h2>1. 正交补偿能解释多少批次差异</h2>${comparison}<table><tr><th>条件</th><th>夹角 °</th><th>总场P95 px</th><th>总场P95 % scan</th><th>总场P95 nm</th><th>非线性P95 px</th><th>残差P95 px</th><th>质量</th></tr>${rows}</table>
    <p>固定中心补偿解释了这对图总场P95差值的约${percent.toFixed(1)}%。这是幅度差的描述，不是误差能量贡献率。补偿后总场与第二批仍差${(fixed.stats.p95-recent.stats.p95).toFixed(2)} px，不能仅凭剪切下降认定结果一致。</p>
    <p>补偿后的剪切P95约${fixed.modes.shear.p95.toFixed(2)} px，横纵尺度差仍约${fixed.modes.differentialScale.p95.toFixed(2)} px；第二批横纵尺度差约${recent.modes.differentialScale.p95.toFixed(2)} px，剩余差异主要体现在线性尺度项。各mode的P95不能相加。</p>
    <p>固定中心：同一中心、同一行列编号、同一评价范围，只改变坐标。重新检测：双三次插值后居中截取同大小扫描区，再重新检测，包含边界、插值和分割变化。前者沿用原图质量状态，不是独立验证。后者质量状态由重新分析产生。第二批原图需复核，小幅非线性和mode差异不可作为已验证的精度改善。</p>
    ${fullSection}<h2>2. 单位与解释范围</h2><p>% scan=位移/原始扫描区宽度×100；% pitch=位移/理想栅格周期×100；nm=位移×FOV(µm)×1000/图像宽度。单对测试使用原图页脚FOV；完整补偿测试未手动输入FOV，其nm按倍率估算。其他图缺少逐图FOV时也按倍率估算并明确标识。百分比解决分辨率尺度问题，但不能消除倍率、视场差异。补偿后nm表示沿用原图标尺的等效位移，不是对变换后各方向像素尺寸的独立标定。</p>
    <h2>3. 电压 倍率 分辨率和时间的依赖分析</h2>
    <p>2026年10月10日按最新确认调整：采样率指文件名里的倍率（×），不是扫描频率或驻留时间。前三项来自文件名，时间使用文件夹的采集批次日期。只有两批时间，当前只能给出匹配条件下的前后差异，不能识别连续漂移曲线，也不能区分时间、手动校准、视野等因素。</p>
    <p>当前${records.length}个成功计算结果中，仅${accepted.length}个通过质量门槛的结果进入趋势分析，其余单独保留。总场、剪切、横纵尺度差、非线性、径向和切向均用扫描宽度百分比对比；nm结果标明标尺来源。变化率是实际起终点的相对变化，不是因果贡献率。每条曲线显示已记录条件匹配的结果，未记录的条件仍可能混杂。</p>${sections}
    <h2>下一步采集</h2><p>固定电压、倍率、分辨率、视野和工作距离，记录校准时刻，在0、5、15、30、60分钟分别重复采集。工作距离和尺幅另做单变量多水平实验。每个水平至少重复3次，保留校准及操作日志，再比较线性与非线性趋势和影响幅度。</p></html>`;
  fs.writeFileSync(path.join(OUT,'test-report.html'),html);
  fs.writeFileSync(path.join(__dirname,'public','parameter-report.html'),html);
  fs.writeFileSync(path.join(__dirname,'public','parameter-analysis.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=parameter-dashboard.html"><title>参数依赖图表</title><a href="parameter-dashboard.html">打开参数依赖图表</a></html>');
  fs.writeFileSync(path.join(__dirname,'public','parameter-analysis-data.json'),JSON.stringify({
    generatedAt:new Date().toISOString(),source:'2026-10-08 same-code reanalysis cache',
    included:accepted.length,reviewExcluded:records.length-accepted.length,errorExcluded:data.records.length-records.length,
    records,analyses,compensation:full
  }));
  console.log(`Saved ${OUT}; accepted ${accepted.length}; original gap reduction ${percent.toFixed(1)}%`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const image = new Image();
const squareMask = new Image();
let result = null;
let fitScale = 1;
let zoom = 1;
let panX = 0;
let panY = 0;
let dragging = false;
let dragStart = null;
let dragMoved = false;
const excludedRows = new Set();
const excludedColumns = new Set();
let batchResults = [];
let rectifiedLayout = null;
let fieldRedrawTimer = null;

const heatStops = [
  [0,[48,18,59]], [.18,[70,105,200]], [.4,[53,183,121]],
  [.62,[253,231,37]], [.82,[240,90,40]], [1,[122,4,3]]
];

function heatColor(value) {
  const t = Math.max(0, Math.min(1, value));
  let a = heatStops[0], b = heatStops.at(-1);
  for (let i=1;i<heatStops.length;i++) if (t <= heatStops[i][0]) { a=heatStops[i-1]; b=heatStops[i]; break; }
  const f = (t-a[0])/(b[0]-a[0] || 1);
  return `rgb(${a[1].map((v,i)=>Math.round(v+(b[1][i]-v)*f)).join(',')})`;
}

function selectedField() {
  const mode=$('fieldComponent')?.value||'total';
  const field=result.distortion;
  const stats=mode==='total'?field.stats:field.decomposition.stats[mode];
  return {mode,stats,vector:p=>mode==='total'?{dx:p.dx,dy:p.dy}:{dx:p[`${mode}Dx`],dy:p[`${mode}Dy`]}};
}

function drawDistortionField() {
  const field = result?.distortion;
  if (!field || !$('distortionToggle').checked) return;
  const selected=selectedField();
  const ceiling = Math.max(.001, selected.stats.p95);
  ctx.save();
  const heatCanvas = document.createElement('canvas');
  heatCanvas.width = field.columns; heatCanvas.height = field.rows;
  const heatCtx = heatCanvas.getContext('2d');
  const pixels = heatCtx.createImageData(field.columns, field.rows);
  for (const p of field.samples) {
    const vector=selected.vector(p),magnitude=Math.hypot(vector.dx,vector.dy);
    const color = heatColor(magnitude / ceiling).match(/\d+/g).map(Number);
    const index = (p.row * field.columns + p.column) * 4;
    pixels.data[index] = color[0]; pixels.data[index+1] = color[1]; pixels.data[index+2] = color[2]; pixels.data[index+3] = 255;
  }
  heatCtx.putImageData(pixels, 0, 0);
  // Avoid passing tens of thousands of samples as function arguments.
  let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
  for(const p of field.samples) {
    left=Math.min(left,p.x);right=Math.max(right,p.x);
    top=Math.min(top,p.y);bottom=Math.max(bottom,p.y);
  }
  left-=result.pitch.x/2;right+=result.pitch.x/2;
  top-=result.pitch.y/2;bottom+=result.pitch.y/2;
  ctx.globalAlpha = .52; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(heatCanvas, left, top, right-left, bottom-top);
  ctx.globalAlpha = .9;
  ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff';
  const screenScale = Math.max(.001, fitScale * zoom);
  const transform = ctx.getTransform();
  const pitchScreen = Math.max(.001, Math.min(
    Math.hypot(transform.a, transform.b) * result.pitch.x,
    Math.hypot(transform.c, transform.d) * result.pitch.y
  ) * screenScale);
  // Sample arrows by their spacing on screen, not by a fixed grid stride.
  const arrowStride = Math.max(1, Math.ceil(64 / pitchScreen));
  const maxArrowScreen = Math.min(12, arrowStride * pitchScreen * .22);
  const viewer = $('viewer');
  ctx.lineWidth = 1 / screenScale;
  for (const p of field.samples) {
    if (p.column % arrowStride || p.row % arrowStride) continue;
    const screenX=(transform.a*p.x+transform.c*p.y+transform.e)*screenScale+panX;
    const screenY=(transform.b*p.x+transform.d*p.y+transform.f)*screenScale+panY;
    if(screenX < -20 || screenY < -20 || screenX > viewer.clientWidth+20 || screenY > viewer.clientHeight+20) continue;
    const vector=selected.vector(p);
    const transformedDx=transform.a*vector.dx+transform.c*vector.dy;
    const transformedDy=transform.b*vector.dx+transform.d*vector.dy;
    const vectorScreenLength=Math.hypot(transformedDx,transformedDy)*screenScale;
    if(!Number.isFinite(vectorScreenLength) || vectorScreenLength < 1e-6) continue;
    // Twofold display gain is enough to reveal the direction; cap the result
    // so a high-magnitude field cannot cover its neighbours with arrowheads.
    const gain=Math.min(2/zoom,maxArrowScreen/vectorScreenLength);
    const visibleLength=vectorScreenLength*gain;
    if(visibleLength<2) continue;
    const ex=p.x+vector.dx*gain,ey=p.y+vector.dy*gain;
    ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(ex,ey); ctx.stroke();
    const angle=Math.atan2(ey-p.y,ex-p.x),head=Math.min(3,visibleLength*.23)/screenScale;
    ctx.beginPath(); ctx.moveTo(ex,ey); ctx.lineTo(ex-head*Math.cos(angle-.55),ey-head*Math.sin(angle-.55));
    ctx.lineTo(ex-head*Math.cos(angle+.55),ey-head*Math.sin(angle+.55)); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawRegressionCenters() {
  if (!result?.centers || !$('centersToggle').checked) return;
  // Scale the marker with the detected lattice instead of image dimensions.
  // At 500× an 8K image contains very small cells; the previous width-based
  // radius could make a marker wider than the square it represented.
  const radius = Math.max(1.5,Math.min(result.pitch.x,result.pitch.y)*.12);
  ctx.save();
  ctx.lineWidth = Math.max(1, radius * .24);
  ctx.fillStyle = '#ff2bd6';
  ctx.strokeStyle = '#ffffff';
  for (const p of result.centers) {
    if (excludedRows.has(p.row) || excludedColumns.has(p.column)) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawSquarePixels() {
  if (!$('pixelsToggle').checked || !squareMask.complete || !squareMask.naturalWidth) return;
  ctx.drawImage(squareMask, 0, 0);
}

function applyTransform() {
  if (!image.naturalWidth) return;
  const scale = fitScale * zoom;
  canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  $('zoomLabel').textContent = `Zoom: ${Math.round(zoom * 100)}%`;
}

function fitToView() {
  if (!image.naturalWidth) return;
  const viewer = $('viewer');
  const margin = 20;
  fitScale = Math.min(
    (viewer.clientWidth - margin * 2) / canvas.width,
    (viewer.clientHeight - margin * 2) / canvas.height
  );
  zoom = 1;
  panX = (viewer.clientWidth - canvas.width * fitScale) / 2;
  panY = (viewer.clientHeight - canvas.height * fitScale) / 2;
  applyTransform();
  if(result && $('distortionToggle').checked) draw();
}

function setStatus(label, busy = false) {
  $('status').classList.toggle('busy', busy);
  $('status').querySelector('b').textContent = label;
}

function draw() {
  if (!image.complete || !image.naturalWidth) return;
  // Assigning even an unchanged canvas dimension discards its backing store.
  // Zoom redraws must reuse it, particularly for 8K/16K images.
  ctx.setTransform(1,0,0,1,0,0);
  ctx.globalAlpha=1;
  rectifiedLayout=null;
  if(result?.rectification&&$('rectifiedToggle').checked) {
    const matrix=result.rectification.correctionMatrix;
    const size=Math.min(result.image.width,result.image.specimenHeight);
    const corners=[[0,0],[size,0],[0,size],[size,size]].map(([x,y])=>({
      x:matrix[0][0]*x+matrix[0][1]*y,
      y:matrix[1][0]*x+matrix[1][1]*y
    }));
    const minX=Math.min(...corners.map(p=>p.x)),maxX=Math.max(...corners.map(p=>p.x));
    const minY=Math.min(...corners.map(p=>p.y)),maxY=Math.max(...corners.map(p=>p.y));
    const width=Math.ceil(maxX-minX),height=Math.ceil(maxY-minY);
    if(canvas.width!==width) canvas.width=width;
    if(canvas.height!==height) canvas.height=height;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    rectifiedLayout={matrix,offsetX:-minX,offsetY:-minY};
    ctx.fillStyle='#080808';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.setTransform(matrix[0][0],matrix[1][0],matrix[0][1],matrix[1][1],-minX,-minY);
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    ctx.drawImage(image,0,0,size,size,0,0,size,size);
  } else {
    if(canvas.width!==image.naturalWidth) canvas.width=image.naturalWidth;
    if(canvas.height!==image.naturalHeight) canvas.height=image.naturalHeight;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(image,0,0);
  }
  if (!result) return;
  drawDistortionField();
  drawSquarePixels();
  drawRegressionCenters();
  if (!$('toggle').checked) return;
  ctx.save();
  ctx.lineWidth = Math.max(2, image.naturalWidth / 1800);
  ctx.globalAlpha = .92;
  ctx.strokeStyle = '#20e0d5';
  for (const l of result.vertical) {
    if (excludedColumns.has(l.index)) continue;
    ctx.beginPath(); l.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
  }
  ctx.strokeStyle = '#ff9850';
  for (const l of result.horizontal) {
    if (excludedRows.has(l.index)) continue;
    ctx.beginPath(); l.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
  }
  ctx.restore();
}

function resetSingleAnalysis() {
  result=null;excludedRows.clear();excludedColumns.clear();
  $('rectifiedToggle').checked=false;rectifiedLayout=null;
  squareMask.removeAttribute('src');
  $('exportRectified').title='';
  $('compensationResult').textContent='完整补偿包含线性及非线性位移；点击验证将重新检测补偿后的图像。';
  for(const id of ['toggle','centersToggle','pixelsToggle','distortionToggle','rectifiedToggle','fieldComponent','exportJson','exportPng','exportRectified','exportCompensated','validateCompensation','distortion','restoreLines']) {
    $(id).disabled=true;
  }
  for(const id of ['verticalCount','horizontalCount','squareCount','fitCenterCount','qualityStatus','clusterPeriod','coverage','lineResidual','fitResidual','pitchX','pitchY','rowTilt','columnTilt','includedAngle','rectifiedPitch']) $(id).textContent='—';
  $('clusterHint').textContent='有稳定重复分区时保留样品间距；证据不足时使用等间距参考。';
  draw();
}

async function loadCurrentImage(providedMetadata=null) {
  $('physicalFov').value='';
  setStatus('Loading', true);
  let meta=providedMetadata;
  if(!meta) {
    const response=await fetch('/api/metadata');
    meta=await response.json();
    if(!response.ok) throw new Error(meta.error||'无法读取图像信息');
  }
  resetSingleAnalysis();
  const response=await fetch(`/api/image?t=${Date.now()}`);
  if(!response.ok) {
    const error=await response.json().catch(()=>({}));
    throw new Error(`图像预览生成失败：${error.error||`HTTP ${response.status}`}`);
  }
  const previewUrl=URL.createObjectURL(await response.blob());
  await new Promise((resolve,reject)=>{
    image.onload=resolve;
    image.onerror=()=>reject(new Error('图像预览解码失败，请重新加载或检查文件是否完整'));
    image.src=previewUrl;
  }).finally(()=>{
    image.onload=null;image.onerror=null;URL.revokeObjectURL(previewUrl);
  });
    $('empty').style.display = 'none'; canvas.style.display = 'block';
    $('viewer').classList.add('has-image');
    $('dimensions').textContent = `${meta.width} × ${meta.height} px`;
    $('filename').textContent = meta.filename;
    $('extract').disabled = false; $('fitView').disabled = false;
    draw(); fitToView(); setStatus('Image loaded');
}

$('load').onclick=()=>loadCurrentImage().catch(error=>{setStatus('Load error');alert(error.message);});
$('sourceFile').onchange=()=>{$('loadSource').disabled=!$('sourceFile').files.length;};
$('loadSource').onclick=async()=>{
  const file=$('sourceFile').files[0];
  if(!file) return;
  $('loadSource').disabled=true;$('sourceFile').disabled=true;setStatus('Uploading source',true);
  try {
    const response=await fetch('/api/source',{
      method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':encodeURIComponent(file.name)},body:file
    });
    const metadata=await response.json();
    if(!response.ok) throw new Error(metadata.error||'Could not load TIFF');
    await loadCurrentImage(metadata);
  } catch(error) {
    setStatus('Upload error');alert(error.message);
  } finally {
    $('sourceFile').disabled=false;$('loadSource').disabled=!$('sourceFile').files.length;
  }
};
$('restoreDefaultSource').onclick=async()=>{
  setStatus('Restoring default',true);
  try {
    const response=await fetch('/api/source/default',{method:'POST'});
    const metadata=await response.json();
    if(!response.ok) throw new Error(metadata.error||'Could not restore default image');
    $('sourceFile').value='';$('loadSource').disabled=true;
    await loadCurrentImage(metadata);
  } catch(error) {setStatus('Load error');alert(error.message);}
};

$('extract').onclick = async () => {
  $('loader').style.display = 'grid'; $('extract').disabled = true;
  setStatus('Analyzing', true);
  try {
    const fovText=$('physicalFov').value.trim();
    if(fovText && (!Number.isFinite(Number(fovText))||Number(fovText)<=0)) throw new Error('FOV must be a positive number in µm');
    const response = await fetch('/api/analyze', { method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({fovMicrometers:fovText?Number(fovText):null}) });
    if (!response.ok) throw new Error((await response.json()).error || 'Analysis failed');
    result = await response.json();
    excludedRows.clear(); excludedColumns.clear();
    $('verticalCount').textContent = result.vertical.length;
    $('horizontalCount').textContent = result.horizontal.length;
    $('squareCount').textContent = `${result.squareExtraction.detected} / ${result.squareExtraction.expected}`;
    $('fitCenterCount').textContent = `${result.distortion.fitSampleCount} / ${result.centers.length} (${(result.quality.fitRate*100).toFixed(1)}%)`;
    $('qualityStatus').textContent = result.quality.status.toUpperCase();
    $('qualityStatus').title = result.quality.warnings.join('\n') || 'All automatic quality checks passed';
    $('coverage').textContent = `${(result.quality.minimumInteriorRowCoverage*100).toFixed(1)}% / ${(result.quality.minimumInteriorColumnCoverage*100).toFixed(1)}%`;
    const lineFit=result.quality.lineFitResidual;
    $('lineResidual').textContent=lineFit.horizontal.p95==null||lineFit.vertical.p95==null
      ? 'unavailable'
      : `${lineFit.horizontal.p95.toFixed(2)} / ${lineFit.vertical.p95.toFixed(2)} px`;
    $('fitResidual').textContent = `${result.distortion.fitResidualStats.p95.toFixed(2)} px`;
    $('pitchX').textContent = `${result.pitch.x.toFixed(2)} px`;
    $('pitchY').textContent = `${result.pitch.y.toFixed(2)} px`;
    if(result.rectification) {
      $('rowTilt').textContent=`${result.rectification.rowTiltDegrees.toFixed(3)}°`;
      $('columnTilt').textContent=`${result.rectification.columnTiltDegrees.toFixed(3)}°`;
      $('includedAngle').textContent=`${result.rectification.includedAngleDegrees.toFixed(3)}°`;
      $('rectifiedPitch').textContent=`${result.rectification.targetPitchPx.toFixed(2)} px`;
      $('exportRectified').disabled=false;
      $('exportRectified').title=result.quality.status==='ok'
        ? 'Correct the average grid rotation, shear, and axis scale'
        : `Exploratory correction: ${result.quality.warnings.join('; ')}`;
    }
    $('toggle').disabled = false; $('centersToggle').disabled = false;
    $('rectifiedToggle').disabled=!result.rectification;
    $('pixelsToggle').disabled = false; $('pixelsToggle').checked = true;
    $('centersToggle').checked = true;
    $('exportJson').disabled = false; $('exportPng').disabled = false;
    $('distortion').disabled = false;
    $('exportCompensated').disabled=false;$('validateCompensation').disabled=false;
    $('restoreLines').disabled = false;
    squareMask.onload = draw;
    squareMask.src = `/api/square-mask?t=${Date.now()}`;
    draw(); setStatus(result.quality.status==='ok'?'Extraction complete':'Extraction needs review');
  } catch (e) { setStatus('Error'); alert(e.message); }
  finally { $('loader').style.display = 'none'; $('extract').disabled = false; }
};

$('toggle').onchange = draw;
$('rectifiedToggle').onchange=()=>{draw();fitToView();};
$('pixelsToggle').onchange = draw;
$('centersToggle').onchange = draw;
$('distortionToggle').onchange = draw;
$('distortion').onclick = () => {
  const field = result.distortion;
  updateDistortionNumbers(field);
  $('fieldComponent').disabled = false;
  $('distortionToggle').disabled = false;
  $('distortionToggle').checked = true;
  draw(); setStatus('Distortion field ready');
};

function updateDistortionNumbers(field) {
  const reference=field.referenceLattice;
  if($('clusterPeriod')) {
    $('clusterPeriod').textContent=reference?`${reference.column.period??'未检出'} / ${reference.row.period??'未检出'}`:'未检出';
    $('clusterHint').textContent=reference&&(reference.column.period||reference.row.period)
      ?'已将稳定重复间距作为样品结构保留；该归因依赖样品分区设计的确认，非独立绝对标定。'
      :'未检出足够稳定的重复分区，仍使用等间距参考；少于三个完整周期时无法可靠估计。';
  }
  const d=field.decomposition,c=d.coefficients.normalized,selected=selectedField();
  $('radialType').textContent=d.classification==='barrel'?'Barrel (桶型)':d.classification==='pincushion'?'Pincushion (枕型)':'Negligible';
  const unit=$('fieldUnit').value;
  const label={px:'px',nm:'nm',um:'µm',scanPercent:'% scan',pitchPercent:'% pitch'}[unit];
  const format=value=>{const converted=DistortionUnits.convert(value,field,unit);return converted==null?'Unavailable':`${converted.toFixed(unit.includes('Percent')?4:2)} ${label}`;};
  $('radialEdge').textContent=format(d.radialEdgeDisplacement);
  $('radialCoeffs').textContent=`${c.k1.toExponential(2)} / ${c.k2.toExponential(2)} / ${c.k3.toExponential(2)}`;
  $('tangentCoeffs').textContent=`${c.p1.toExponential(2)} / ${c.p2.toExponential(2)}`;
  $('idealPitch').textContent = `${field.idealPitch.toFixed(2)} px`;
  $('imageSize').textContent=`${field.image.width} × ${field.image.height} px`;
  $('pixelSize').textContent=field.physical.nanometersPerPixel==null?'Unavailable':`${field.physical.nanometersPerPixel.toFixed(3)} nm/px`;
  $('scaleSource').textContent=`${field.physical.source}; % scan uses original scan width. Unit changes do not change the fit.`;
  $('distMean').textContent=format(selected.stats.mean);
  $('distRms').textContent=format(selected.stats.rms);
  $('distP95').textContent=format(selected.stats.p95);
  $('distMax').textContent=format(selected.stats.max);
  $('legendMax').textContent=`${format(selected.stats.p95)}+`;
  $('legendZero').textContent=`0 ${label}`;
}
$('fieldUnit').onchange=()=>{if(result?.distortion) updateDistortionNumbers(result.distortion);};

async function recomputeDistortion() {
  const response=await fetch('/api/distortion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:[...excludedRows],columns:[...excludedColumns]})});
  if(!response.ok) throw new Error('Could not recompute distortion field');
  result.distortion=await response.json();
  updateDistortionNumbers(result.distortion);
}

function pointSegmentDistance(px,py,line) {
  const dx=line.x2-line.x1,dy=line.y2-line.y1,length=dx*dx+dy*dy;
  const t=length?Math.max(0,Math.min(1,((px-line.x1)*dx+(py-line.y1)*dy)/length)):0;
  return Math.hypot(px-(line.x1+t*dx),py-(line.y1+t*dy));
}

async function toggleNearestLine(event) {
  if(!result) return;
  const rect=$('viewer').getBoundingClientRect(),scale=fitScale*zoom;
  let x=(event.clientX-rect.left-panX)/scale,y=(event.clientY-rect.top-panY)/scale;
  if(rectifiedLayout) {
    const [[a,b],[c,d]]=rectifiedLayout.matrix;
    const det=a*d-b*c,u=x-rectifiedLayout.offsetX,v=y-rectifiedLayout.offsetY;
    x=(d*u-b*v)/det;y=(-c*u+a*v)/det;
  }
  let nearest=null,distance=Infinity;
  for(const line of [...result.vertical,...result.horizontal]) {
    const d=pointSegmentDistance(x,y,line);
    if(d<distance){distance=d;nearest=line;}
  }
  if(!nearest||distance>14/scale) return;
  const set=nearest.orientation==='vertical'?excludedColumns:excludedRows;
  set.has(nearest.index)?set.delete(nearest.index):set.add(nearest.index);
  setStatus('Recomputing',true);
  try{await recomputeDistortion();draw();setStatus(`Excluded ${excludedRows.size} rows, ${excludedColumns.size} columns`);}catch(error){setStatus('Recompute error');alert(error.message);}
}

$('restoreLines').onclick = async () => {
  excludedRows.clear();excludedColumns.clear();
  try{await recomputeDistortion();draw();setStatus('All lines restored');}catch(error){alert(error.message);}
};
$('fieldComponent').onchange=()=>{if(result?.distortion){updateDistortionNumbers(result.distortion);draw();}};
$('fitView').onclick = fitToView;
$('viewer').ondblclick = fitToView;

$('viewer').addEventListener('wheel', event => {
  if (!image.naturalWidth) return;
  event.preventDefault();
  const rect = $('viewer').getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  const oldScale = fitScale * zoom;
  const imageX = (mouseX - panX) / oldScale;
  const imageY = (mouseY - panY) / oldScale;
  const factor = Math.exp(-event.deltaY * 0.0015);
  zoom = Math.min(20, Math.max(0.25, zoom * factor));
  const newScale = fitScale * zoom;
  panX = mouseX - imageX * newScale;
  panY = mouseY - imageY * newScale;
  applyTransform();
  if(result && $('distortionToggle').checked) {
    clearTimeout(fieldRedrawTimer);
    fieldRedrawTimer=setTimeout(draw,120);
  }
}, { passive:false });

$('viewer').addEventListener('pointerdown', event => {
  if (!image.naturalWidth || event.button !== 0) return;
  dragging = true;
  dragMoved = false;
  dragStart = { x:event.clientX, y:event.clientY, panX, panY };
  $('viewer').classList.add('dragging');
  $('viewer').setPointerCapture(event.pointerId);
});
$('viewer').addEventListener('pointermove', event => {
  if (!dragging) return;
  if(Math.hypot(event.clientX-dragStart.x,event.clientY-dragStart.y)>4) dragMoved=true;
  panX = dragStart.panX + event.clientX - dragStart.x;
  panY = dragStart.panY + event.clientY - dragStart.y;
  applyTransform();
});
$('viewer').addEventListener('pointerup', event => {
  const wasClick=!dragMoved;
  dragging = false; $('viewer').classList.remove('dragging');
  if ($('viewer').hasPointerCapture(event.pointerId)) $('viewer').releasePointerCapture(event.pointerId);
  if(wasClick) toggleNearestLine(event);
});
$('viewer').addEventListener('pointercancel', () => {
  dragging = false; $('viewer').classList.remove('dragging');
});
window.addEventListener('resize', () => { if (image.naturalWidth && zoom === 1) fitToView(); });

function renderBatchResults() {
  const container=$('batchResults');
  container.replaceChildren();
  for(const item of batchResults) {
    const quality=item.error?'error':item.quality.status;
    const row=document.createElement('div');row.className='batch-item';
    const heading=document.createElement('div');
    const filename=document.createElement('strong');filename.textContent=item.source.filename;
    const status=document.createElement('b');status.className=quality;status.textContent=quality;
    heading.append(filename,status);row.append(heading);
    const detail=document.createElement('small');
    detail.textContent=item.error
      ? item.error
      : `P95 ${item.distortion.stats.p95.toFixed(2)} px · nonlinear ${item.distortion.decomposition.stats.nonlinear.p95.toFixed(2)} px · ${(item.elapsedSeconds??0).toFixed(1)} s`;
    row.append(detail);container.append(row);
  }
}

function batchCsvRow(item) {
  if(item.error) return {
    filename:item.source.filename,status:'error',error:item.error
  };
  return {
    filename:item.source.filename,status:'ok',error:'',qualityStatus:item.quality.status,
    warnings:item.quality.warnings.join('; '),voltageKv:item.source.voltageKv,
    magnification:item.source.magnification,resolutionK:item.source.resolutionK,
    width:item.image.width,height:item.image.height,pitchX:item.pitch.x,pitchY:item.pitch.y,
    detected:item.squareExtraction.detected,expected:item.squareExtraction.expected,
    recovered:item.squareExtraction.recovered,minRowCoverage:item.quality.minimumInteriorRowCoverage,
    minColumnCoverage:item.quality.minimumInteriorColumnCoverage,fitSamples:item.distortion.fitSampleCount,
    fitResidualP95Px:item.distortion.fitResidualStats.p95,meanPx:item.distortion.stats.mean,
    rmsPx:item.distortion.stats.rms,p95Px:item.distortion.stats.p95,maxPx:item.distortion.stats.max,
    affineP95Px:item.distortion.decomposition.stats.affine.p95,
    nonlinearP95Px:item.distortion.decomposition.stats.nonlinear.p95,
    radialP95Px:item.distortion.decomposition.stats.radial.p95,
    tangentialP95Px:item.distortion.decomposition.stats.tangential.p95,
    rowTiltDeg:item.rectification?.rowTiltDegrees,
    columnTiltDeg:item.rectification?.columnTiltDegrees,
    includedAngleDeg:item.rectification?.includedAngleDegrees,
    orthogonalityErrorDeg:item.rectification?.orthogonalityErrorDegrees,
    rectifiedPitchPx:item.rectification?.targetPitchPx,
    clusterColumnPeriod:item.distortion.referenceLattice?.column.period,
    clusterRowPeriod:item.distortion.referenceLattice?.row.period,
    nanometersPerPixel:item.distortion.physical.nanometersPerPixel,
    ...DistortionUnits.csvFields({...item.distortion,image:item.image}),
    elapsedSeconds:item.elapsedSeconds
  };
}

function csvCell(value) {
  const text=value==null?'':String(value);
  return /[",\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
}

$('batchFiles').onchange=()=>{
  const files=[...$('batchFiles').files];
  $('batchSelection').textContent=files.length
    ? `${files.length} file${files.length===1?'':'s'} selected · ${files.map(file=>file.name).join(', ')}`
    : 'No files selected';
  $('batchAnalyze').disabled=!files.length;
};

$('batchAnalyze').onclick=async()=>{
  const files=[...$('batchFiles').files];
  if(!files.length) return;
  batchResults=[];renderBatchResults();
  $('batchAnalyze').disabled=true;$('batchFiles').disabled=true;
  $('batchExportCsv').disabled=true;$('batchExportJson').disabled=true;
  $('batchProgress').hidden=false;$('batchProgressBar').max=files.length;$('batchProgressBar').value=0;
  for(let index=0;index<files.length;index++) {
    const file=files[index];
    $('batchProgressLabel').textContent=`${index} / ${files.length} · ${file.name}`;
    $('batchProgressPercent').textContent=`${Math.round(index/files.length*100)}%`;
    setStatus(`Batch ${index+1}/${files.length}`,true);
    try {
      const response=await fetch('/api/analyze-upload',{
        method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':encodeURIComponent(file.name)},body:file
      });
      const payload=await response.json();
      if(!response.ok) throw new Error(payload.error||'Analysis failed');
      batchResults.push(payload);
    } catch(error) {
      batchResults.push({source:{filename:file.name},error:error.message});
    }
    renderBatchResults();
    const completed=index+1;
    $('batchProgressBar').value=completed;
    $('batchProgressLabel').textContent=`${completed} / ${files.length}`;
    $('batchProgressPercent').textContent=`${Math.round(completed/files.length*100)}%`;
  }
  $('batchFiles').disabled=false;$('batchAnalyze').disabled=false;
  $('batchExportCsv').disabled=false;$('batchExportJson').disabled=false;
  const failures=batchResults.filter(item=>item.error).length;
  setStatus(failures?`Batch complete · ${failures} failed`:'Batch complete');
};

$('batchExportCsv').onclick=()=>{
  const rows=batchResults.map(batchCsvRow);
  const columns=['filename','status','error','qualityStatus','warnings','voltageKv','magnification','resolutionK','width','height','pitchX','pitchY','detected','expected','recovered','minRowCoverage','minColumnCoverage','fitSamples','fitResidualP95Px','meanPx','rmsPx','p95Px','maxPx','affineP95Px','nonlinearP95Px','radialP95Px','tangentialP95Px','rowTiltDeg','columnTiltDeg','includedAngleDeg','orthogonalityErrorDeg','rectifiedPitchPx','nanometersPerPixel','elapsedSeconds'];
  columns.push('clusterColumnPeriod','clusterRowPeriod');
  columns.push(...DistortionUnits.csvColumns);
  const content=[columns.join(','),...rows.map(row=>columns.map(column=>csvCell(row[column])).join(','))].join('\n');
  download(new Blob([`${content}\n`],{type:'text/csv;charset=utf-8'}),'distortion-summary.csv');
};

$('batchExportJson').onclick=()=>download(
  new Blob([JSON.stringify(batchResults,null,2)],{type:'application/json'}),'distortion-summary.json'
);

$('exportJson').onclick = () => download(new Blob([JSON.stringify(result, null, 2)], {type:'application/json'}), 'grid-lines.json');
$('exportPng').onclick = () => canvas.toBlob(blob => download(blob, 'grid-lines-overlay.png'));
$('exportRectified').onclick=()=>{
  if(!result?.rectification) return;
  const link=document.createElement('a');link.href='/api/rectified-image';link.download='';
  document.body.append(link);link.click();link.remove();
};
$('exportCompensated').onclick=()=>{
  if(!result?.distortion) return;
  const link=document.createElement('a');link.href='/api/rectified-image?mode=full';link.download='';
  document.body.append(link);link.click();link.remove();
};
$('validateCompensation').onclick=async()=>{
  const button=$('validateCompensation');button.disabled=true;
  $('compensationResult').textContent='正在补偿并重新检测图像，大图可能需要数十秒…';
  try {
    const response=await fetch('/api/compensation-validation',{method:'POST'});
    if(response.status===404) throw new Error('新接口尚未加载，请重启算法服务后再验证');
    const report=await response.json();if(!response.ok) throw new Error(report.error||'Validation failed');
    $('compensationResult').textContent=`重新检测平滑总场P95：${report.before.stats.p95.toFixed(2)} → ${report.after.stats.p95.toFixed(2)} px（降低${report.reductionPercent.toFixed(1)}%）；实测中心偏差P95 ${report.after.measuredStats?.p95.toFixed(2)??'未知'} px；补偿后残差${report.after.residual.p95.toFixed(2)} px；质量${report.after.quality.status}；有效像素${(report.validFraction*100).toFixed(1)}%。同图验证不等于独立物理精度标定。`;
    download(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'compensation-validation.json');
  }catch(error){$('compensationResult').textContent=`验证未完成：${error.message}`;}
  finally{button.disabled=!result;}
};
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

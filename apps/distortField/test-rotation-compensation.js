const assert=require('node:assert/strict');
const sharp=require('sharp');
const {analyze,server}=require('./server');
const {compensateImage}=require('./full-compensation');
const {estimateOrientation,rotationTransform}=require('./grid-orientation');
const {rotatedScan}=require('./validate-rotation-compensation');
async function main(){
  const size=640,rects=[];
  for(let y=32;y<size-20;y+=32)for(let x=32;x<size-20;x+=32)rects.push(`<rect x="${x-10}" y="${y-10}" width="20" height="20" fill="#cccccc"/>`);
  const image=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#303030"/>${rects.join('')}</svg>`)).png().toBuffer();
  const base=await analyze(image,{filename:'synthetic-grid.tif',makeMask:false,cacheResult:false});
  const rotated=await rotatedScan(image,5);
  const orientation=await estimateOrientation(rotated,await sharp(rotated).metadata());
  assert.ok(orientation.confidence>.25);assert.ok(Math.abs(orientation.angleDegrees-5)<2);
  const observed=await analyze(rotated,{filename:'synthetic-grid.tif',makeMask:true});
  assert.ok(observed.analysis.orientationNormalization);
  const expanded=await sharp(image).rotate(5).png().toBuffer(),expandedMeta=await sharp(expanded).metadata();
  assert.equal(observed.image.width,expandedMeta.width);assert.equal(observed.image.height,expandedMeta.height);
  assert.ok(expandedMeta.width>size,'Rigid rotation must preserve corners on an expanded canvas');
  const transform=rotationTransform(size,size,5,expandedMeta.width,expandedMeta.height);
  const padX=Math.floor((expandedMeta.width-size)/2),padY=Math.floor((expandedMeta.height-size)/2);
  const expected=base.centers.filter(p=>p.usedForFit!==false&&p.x>48&&p.y>48&&p.x<size-48&&p.y<size-48)
    .map(p=>{const q=transform.forward(p.x,p.y);return {x:q.x+padX,y:q.y+padY};});
  const a=transform.forward(100,100),b=transform.forward(200,100),c=transform.forward(100,200);
  assert.ok(Math.abs(Math.hypot(b.x-a.x,b.y-a.y)-100)<1e-9);
  assert.ok(Math.abs((b.x-a.x)*(c.x-a.x)+(b.y-a.y)*(c.y-a.y))<1e-9,'Pure rotation preserves lengths and right angles');
  const actual=observed.centers.filter(p=>p.usedForFit!==false);
  const errors=expected.map(p=>Math.min(...actual.map(q=>Math.hypot(p.x-q.x,p.y-q.y)))).sort((a,b)=>a-b);
  const p95=errors[Math.floor(errors.length*.95)];assert.ok(p95<1.2,`Mapped centers must remain in original image coordinates: ${p95}`);
  const corrected=await compensateImage(rotated,observed.distortion);
  const after=await analyze(corrected.png,{filename:'synthetic-grid.tif',makeMask:false,cacheResult:false});
  assert.ok(after.distortion.stats.p95<.5);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/square-mask`);
    assert.equal(response.status,200);const m=await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    assert.equal(m.width,expandedMeta.width);assert.equal(m.height,expandedMeta.height);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  console.log(JSON.stringify({mappedCenterP95Px:p95,compensatedP95Px:after.distortion.stats.p95,detected:observed.centers.length}));
  console.log('Actual-pixel rotation, original-frame center mapping, mask dimensions and compensation passed');
}
main().catch(error=>{console.error(error);server.closeAllConnections();server.close();process.exitCode=1;});

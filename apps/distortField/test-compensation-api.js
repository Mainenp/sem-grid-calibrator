const assert=require('node:assert/strict');
const {server}=require('./server');
async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base+'/api/compensation-validation',{method:'POST'})).status,409);
    const original=await fetch(base+'/api/analyze',{method:'POST',body:'{}'});
    assert.equal(original.status,200);
    const body=await original.json();assert.ok(body.distortion.compensationModel);
    assert.ok(body.distortion.compensationModel.fitSupport);
    assert.equal(body.distortion.measuredSamples,undefined,'Internal validation samples must not duplicate the public center array');
    const image=await fetch(base+'/api/rectified-image?mode=full');assert.equal(image.status,200);
    assert.equal(image.headers.get('content-type'),'image/png');
    const png=new Uint8Array(await image.arrayBuffer());assert.equal(png[0],137);assert.equal(png[1],80);
    const response=await fetch(base+'/api/compensation-validation',{method:'POST'});
    assert.equal(response.status,200);
    const report=await response.json();
    assert.ok(report.after.measuredStats.p95>=0);
    assert.ok(report.after.stats.p95<report.before.stats.p95);
    assert.equal(report.commonSupport.supported,true);
    assert.equal(report.commonSupport.status,'improved');
    assert.equal(report.reductionPercent,report.commonSupport.reductionPercent);
    assert.ok(report.commonSupport.after.p95<report.commonSupport.before.p95);
    console.log(JSON.stringify({before:report.before.stats.p95,after:report.after.stats.p95,measured:report.after.measuredStats.p95,quality:report.after.quality.status}));
    console.log('Default 07 full-compensation export and redetection API tests passed');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

const assert=require('node:assert/strict');
const sharp=require('sharp');
const {evaluate,validateModel,compensateImage}=require('./full-compensation');
async function main(){
  const model={lattice:{centerX:31.5,centerY:31.5,meanColumn:3,meanRow:3,c:8,d:0},smooth:{columnCount:7,rowCount:7,dx:Array(10).fill(0),dy:Array(10).fill(0)}};
  assert.deepEqual(evaluate(model,3,3),{x:31.5,y:31.5});
  assert.ok(Math.abs(validateModel(model).minimumJacobian-1)<1e-8);
  const raw=Buffer.from(Array.from({length:64*64},(_,i)=>(i%64)*3));
  const input=await sharp(raw,{raw:{width:64,height:64,channels:1}}).png().toBuffer();
  const corrected=await compensateImage(input,{compensationModel:model,image:{width:64,specimenHeight:64}});
  await assert.rejects(()=>compensateImage(input,{compensationModel:model,image:{width:64,specimenHeight:64},measurementQuality:{pitchPriorError:.3,detectionRate:.9}}),/refused/);
  const out=await sharp(corrected.png).greyscale().raw().toBuffer();
  assert.equal(out[32*64+32],raw[32*64+32]);
  assert.equal(out[0],0);assert.ok(corrected.validFraction>0.5);
  model.smooth.dx[1]=-40;
  assert.throws(()=>validateModel(model),/folds/);
  console.log('Full compensation identity, support mask and folding rejection tests passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

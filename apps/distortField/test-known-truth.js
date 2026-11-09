const assert=require('node:assert/strict');
const {benchmark,cases}=require('./synthetic-accuracy');
const {validateModel}=require('./full-compensation');
async function main(){
 const ideal=await benchmark(cases.find(c=>c.name==='ideal'));
 assert.equal(ideal.status,'analyzed');assert.ok(ideal.recall>.99);assert.ok(ideal.centerError.p95<.15);
 assert.ok(ideal.reportedField.p95<.01,'A uniformly sampled perfect grid must not acquire a false field');
 const higher=await benchmark(cases.find(c=>c.name==='higher-order'));
 assert.equal(higher.modelSelection.selectedDegree,5);assert.ok(higher.fieldVectorError.p95<.3);
 assert.ok(higher.heldOut.vectorError.p95<.35,'Independent truth points absent from fitting and order selection must agree');
 assert.ok(higher.compensation.analyticTargetError.p95<.4);assert.ok(higher.compensation.analyticTargetMatchFraction>.95);
 const noisy=await benchmark({name:'validation-noisy',pitch:48,noise:70,seed:901,contrast:60});
 assert.equal(noisy.modelSelection.selectedDegree,3,'Do not select a high-order correction to fit independent pixel noise');
 const unsupported=await benchmark({name:'strong-missing-test',pitch:48,missing:true});
 assert.ok(unsupported.recall<.99,'Missing targets cannot become manufactured truth centers');
 assert.throws(()=>validateModel({smooth:{degree:5,columnCount:10,rowCount:10,dx:Array(10).fill(0),dy:Array(10).fill(0)},lattice:{c:48,d:0}}),/polynomial/);
 console.log('PASS: ideal zero field, absolute synthetic center coordinates, fifth-order known field, independently held-out predictions, analytic output reference, noise non-selection and malformed polynomial refusal');
}
main().catch(e=>{console.error(e);process.exitCode=1});

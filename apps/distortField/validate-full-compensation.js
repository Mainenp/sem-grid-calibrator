const fs=require('fs');
const path=require('path');
const {analyze}=require('./server');
const {compensateImage,validationSummary}=require('./full-compensation');
async function main(){
  const [input,destination]=process.argv.slice(2);
  if(!input||!destination) throw new Error('Usage: node validate-full-compensation.js input.tif NEW-output-directory');
  const out=path.resolve(destination);
  if(fs.existsSync(out)) throw new Error('Choose a new output directory to preserve earlier results');
  const before=await analyze(input,{makeMask:false,cacheResult:false});
  const corrected=await compensateImage(input,before.distortion);
  const after=await analyze(corrected.png,{filename:path.basename(input),makeMask:false,cacheResult:false});
  const report=validationSummary(before.distortion,before.quality,after,corrected);
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'full-compensated.png'),corrected.png);
  fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify({input,...report},null,2));
  console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

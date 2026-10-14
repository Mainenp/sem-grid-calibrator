const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {pipeline}=require('stream/promises');
const {analyze,rectifiedImagePipeline}=require('./server');
const {correction}=require('./orthogonality');

async function main() {
  const [input,output]=process.argv.slice(2);
  if(!input||!output||!/^.+\.png$/i.test(output)) {
    throw new Error('Usage: node rectify-image.js input.tif output.png [--angle-only]');
  }
  const inputPath=path.resolve(input),outputPath=path.resolve(output);
  if(inputPath===outputPath) throw new Error('Input and output paths must differ');
  if(fs.existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
  const result=await analyze(inputPath,{makeMask:false,cacheResult:false});
  if(!result.rectification) throw new Error('Not enough reliable grid centers for rectification');
  const angleOnly=process.argv.includes('--angle-only');
  const geometry=angleOnly?correction(result.rectification):result.rectification;
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  const temporaryPath=path.join(path.dirname(outputPath),`.${path.basename(outputPath)}.${crypto.randomUUID()}.tmp`);
  try {
    await pipeline(rectifiedImagePipeline(inputPath,geometry,result.image.specimenHeight),
      fs.createWriteStream(temporaryPath,{flags:'wx'}));
    fs.linkSync(temporaryPath,outputPath);
  } catch(error) {
    throw error;
  } finally {
    fs.rmSync(temporaryPath,{force:true});
  }
  console.log(JSON.stringify({
    input:inputPath,output:outputPath,qualityStatus:result.quality.status,
    warnings:result.quality.warnings,
    rowTiltDeg:geometry.rowTiltDegrees,columnTiltDeg:geometry.columnTiltDegrees,
    includedAngleDeg:geometry.includedAngleDegrees,
    rectifiedPitchPx:geometry.targetPitchPx,
    mode:angleOnly?'angle-only':'square rectification'
  },null,2));
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});

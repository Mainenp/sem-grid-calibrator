const assert=require('node:assert/strict');
const fs=require('node:fs');
const sharp=require('sharp');
const inputOptions=require('./image-input');
const {server,analyze}=require('./server');

// Append a legal TIFF IFD containing an ImageDescription with an internal NUL.
// Existing pixel offsets remain unchanged, so only metadata differs.
function withNullDescription(tiff) {
  assert.equal(tiff.toString('ascii',0,2),'II');
  const offset=tiff.readUInt32LE(4),count=tiff.readUInt16LE(offset);
  const entries=[];
  for(let i=0;i<count;i++) {
    const entry=tiff.subarray(offset+2+i*12,offset+14+i*12);
    if(entry.readUInt16LE(0)!==270)entries.push(Buffer.from(entry));
  }
  const description=Buffer.from('metadata\0with nul\0');
  const entry=Buffer.alloc(12);entry.writeUInt16LE(270,0);entry.writeUInt16LE(2,2);
  entry.writeUInt32LE(description.length,4);
  const nextOffset=tiff.length+(tiff.length%2);
  entry.writeUInt32LE(nextOffset+2+(entries.length+1)*12+4,8);
  entries.push(entry);entries.sort((a,b)=>a.readUInt16LE(0)-b.readUInt16LE(0));
  const head=Buffer.from(tiff);head.writeUInt32LE(nextOffset,4);
  const total=Buffer.alloc(2);total.writeUInt16LE(entries.length);
  const next=tiff.subarray(offset+2+count*12,offset+6+count*12);
  return Buffer.concat([head,Buffer.alloc(tiff.length%2),total,...entries,next,description]);
}
async function main(){
  const normal=await sharp({create:{width:64,height:64,channels:3,background:'#8090a0'}}).tiff({compression:'none'}).toBuffer();
  const warning=withNullDescription(normal);
  await assert.rejects(()=>sharp(warning).raw().toBuffer(),/Warning treated as error|ImageDescription/);
  const expected=await sharp(normal,inputOptions).raw().toBuffer();
  assert.deepEqual(await sharp(warning,inputOptions).raw().toBuffer(),expected,'Ignoring metadata warnings must not change pixels');
  await assert.rejects(()=>sharp(normal.subarray(0,30),inputOptions).raw().toBuffer());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const bytes=process.argv[2]?fs.readFileSync(process.argv[2]):warning;
    const filename=process.argv[2]?require('node:path').basename(process.argv[2]):'warning.tif';
    const response=await fetch(base+'/api/source',{method:'POST',headers:{'X-Filename':encodeURIComponent(filename)},body:bytes});
    assert.equal(response.status,200);console.log('Uploaded',await response.json());
    const preview=await fetch(base+'/api/image');assert.equal(preview.status,200);
    assert.equal(preview.headers.get('content-type'),'image/png');
    const png=Buffer.from(await preview.arrayBuffer());
    assert.equal(png.readUInt32BE(0),0x89504e47);
    console.log('Preview decoded',await sharp(png).metadata().then(m=>`${m.width} × ${m.height}`));
    if(process.argv[2]) {
      const result=await analyze(bytes,{filename,makeMask:false,cacheResult:false});
      console.log(JSON.stringify({detected:result.squareExtraction.detected,pitch:result.pitch,quality:result.quality.status,p95:result.distortion.stats.p95}));
    }
    const corrupt=await fetch(base+'/api/source',{method:'POST',headers:{'X-Filename':'corrupt.tif'},body:normal.subarray(0,30)});
    assert.equal(corrupt.status,500);
    assert.equal((await fetch(base+'/api/metadata').then(r=>r.json())).filename,filename,'Rejected upload must not replace current source');
    console.log('TIFF warning compatibility, pixel equality, invalid-file rejection and preview API passed');
  }finally{
    const defaultFile=process.env.SEM_GRID_IMAGE||require('node:path').join(__dirname,'data','0.5kv-2000x-4K_07.tif');
    if(fs.existsSync(defaultFile))await fetch(base+'/api/source/default',{method:'POST'});
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

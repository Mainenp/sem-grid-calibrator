const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'public/app.js'),'utf8');
const loader=source.slice(source.indexOf('async function loadCurrentImage('),source.indexOf("$('load').onclick="));
async function run({httpError=false,decodeError=false,metadataError=false}={}){
  const elements={};let reset=0,revoked=0;
  const image={set src(value){queueMicrotask(()=>decodeError?this.onerror():this.onload());}};
  const env={image,canvas:{style:{}},$:id=>elements[id]??=(id==='viewer'?{classList:{add() {}}}:{style:{}}),
    setStatus(){},resetSingleAnalysis(){reset++;},draw(){},fitToView(){},
    URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){revoked++;}},
    fetch:async url=>url==='/api/metadata'?{ok:!metadataError,json:async()=>metadataError?{error:'bad metadata'}:{filename:'grid.tif',width:64,height:64}}:
      {ok:!httpError,status:httpError?500:200,json:async()=>({error:'decoder failed'}),blob:async()=>({})}};
  vm.createContext(env);vm.runInContext(loader,env);
  if(metadataError)await assert.rejects(()=>env.loadCurrentImage(),/bad metadata/);
  else if(httpError)await assert.rejects(()=>env.loadCurrentImage(),/decoder failed/);
  else if(decodeError)await assert.rejects(()=>env.loadCurrentImage(),/预览解码失败/);
  else {await env.loadCurrentImage();assert.equal(elements.filename.textContent,'grid.tif');assert.equal(elements.extract.disabled,false);}
  assert.equal(revoked,metadataError||httpError?0:1);
  assert.equal(reset,metadataError?0:1);
}
(async()=>{await run();await run({httpError:true});await run({decodeError:true});await run({metadataError:true});console.log('Preview success, HTTP errors, browser decoding errors and URL cleanup passed');})().catch(e=>{console.error(e);process.exitCode=1;});

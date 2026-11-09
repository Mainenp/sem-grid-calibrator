const sharp=require('sharp');
const inputOptions=require('./image-input');
// Square edges have four-fold orientation symmetry. A weighted fourth angular
// moment estimates pose without identifying rows or changing grid geometry.
async function estimateOrientation(input,metadata){
  const size=Math.min(metadata.width,metadata.height),crop=Math.min(1200,Math.floor(size*.7)),margin=Math.floor((size-crop)/2);
  async function atScale(sigma){
  const {data,info}=await sharp(input,inputOptions).extract({left:margin,top:margin,width:crop,height:crop})
    .greyscale().blur(sigma).raw().toBuffer({resolveWithObject:true});
  let cosine=0,sine=0,total=0;
  const w=info.width,h=info.height;
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x,dx=data[i+1]-data[i-1],dy=data[i+w]-data[i-w],weight=dx*dx+dy*dy;
    if(weight<25)continue;
    const angle=4*Math.atan2(dy,dx);cosine+=weight*Math.cos(angle);sine+=weight*Math.sin(angle);total+=weight;
  }
  return {angleDegrees:Math.atan2(sine,cosine)*45/Math.PI,confidence:Math.hypot(cosine,sine)/Math.max(1,total),sigma,method:'four-fold grayscale edge orientation'};
  }
  const fine=await atScale(.8);
  if(fine.confidence>.25)return fine;
  // Grain inside large squares can dominate the edge moment. A fallback is
  // accepted only when two smoothing scales independently agree modulo 90°.
  const medium=await atScale(1.6),coarse=await atScale(3.2);
  const difference=Math.abs(((medium.angleDegrees-coarse.angleDegrees+135)%90)-45);
  if(medium.confidence>.3&&coarse.confidence>.3&&difference<2)
    return {...coarse,method:'replicated multiscale four-fold edge orientation',crossScaleDifferenceDegrees:difference};
  return fine;
}
// libvips rotates around the origin, rounds the bounding-box origin to an
// integer, then sharp's centered crop removes integer padding. Using an assumed
// image-center rotation introduces a systematic ~1 px coordinate offset.
function rotationTransform(width,height,degrees,outputWidth,outputHeight){
  const a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  const left=Math.floor((outputWidth-width)/2),top=Math.floor((outputHeight-height)/2);
  const tx=-Math.round(Math.min(0,c*width,-s*height,c*width-s*height))-left;
  const ty=-Math.round(Math.min(0,s*width,c*height,s*width+c*height))-top;
  return {c,s,tx,ty,forward:(x,y)=>({x:c*x-s*y+tx,y:s*x+c*y+ty}),
    inverse:(x,y)=>({x:c*(x-tx)+s*(y-ty),y:-s*(x-tx)+c*(y-ty)})};
}
module.exports={estimateOrientation,rotationTransform};

// Padding is only the near-black region connected to the outside. Dark holes
// inside a specimen must not be treated as missing scan support.
function paddingDistance(data,width,height){
  const invalid=new Uint8Array(width*height),queue=new Int32Array(width*height);let head=0,tail=0;
  const add=i=>{if(!invalid[i]&&data[i]<=1){invalid[i]=1;queue[tail++]=i;}};
  for(let x=0;x<width;x++){add(x);add((height-1)*width+x);}
  for(let y=0;y<height;y++){add(y*width);add(y*width+width-1);}
  while(head<tail){const i=queue[head++],x=i%width,y=Math.floor(i/width);if(x)add(i-1);if(x+1<width)add(i+1);if(y)add(i-width);if(y+1<height)add(i+width);}
  const distance=new Uint16Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x;if(invalid[i]||x===0||y===0||x===width-1||y===height-1)continue;
    distance[i]=Math.min(65534,distance[i-1]+1,distance[i-width]+1,distance[i-width-1]+1,distance[i-width+1]+1);
  }
  for(let y=height-2;y>0;y--)for(let x=width-2;x>0;x--){const i=y*width+x;if(!invalid[i])distance[i]=Math.min(distance[i],distance[i+1]+1,distance[i+width]+1,distance[i+width-1]+1,distance[i+width+1]+1);}
  return distance;
}
module.exports={paddingDistance};

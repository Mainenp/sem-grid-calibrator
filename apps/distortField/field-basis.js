// Keep the legacy ten cubic coefficients in their original order. Higher
// degrees append homogeneous terms, making stored cubic models compatible.
function surfaceTerms(column,row,columnCount,rowCount,degree=3){
 const u=columnCount>1?2*column/(columnCount-1)-1:0,v=rowCount>1?2*row/(rowCount-1)-1:0;
 const t=[1,u,v,u*u,u*v,v*v,u*u*u,u*u*v,u*v*v,v*v*v];
 for(let d=4;d<=degree;d++)for(let power=d;power>=0;power--)t.push(u**power*v**(d-power));
 return t;
}
function evaluateField(field,column,row){
 const terms=surfaceTerms(column,row,field.columnCount,field.rowCount,field.degree||3);
 return {dx:field.dx.reduce((s,c,i)=>s+c*terms[i],0),dy:field.dy.reduce((s,c,i)=>s+c*terms[i],0)};
}
module.exports={surfaceTerms,evaluateField};

// Angle-only, area-preserving shear. No pitch equalization or global rotation.
function correction(geometry) {
  if(!geometry) throw new Error('Reliable grid geometry is required');
  const theta=geometry.includedAngleDegrees*Math.PI/180;
  const phi=geometry.rowTiltDegrees*Math.PI/180;
  if(!Number.isFinite(theta)||Math.sin(theta)<.2||theta<=0||theta>=Math.PI) throw new Error('Degenerate grid angle');
  const c=Math.cos(phi),s=Math.sin(phi),k=-Math.cos(theta)/Math.sin(theta);
  // R(phi) [[1,k],[0,1]] R(-phi); fixes row direction and normal pitch.
  return {correctionMatrix:[[1-k*c*s,k*c*c],[-k*s*s,1+k*s*c]],
    includedAngleDegrees:geometry.includedAngleDegrees,rowTiltDegrees:geometry.rowTiltDegrees,
    shearFactor:k,method:'angle-only area-preserving shear; row direction and perpendicular pitch retained'};
}
function transform(point,matrix,origin={x:0,y:0}) {
  const x=point.x-origin.x,y=point.y-origin.y;
  return {...point,x:origin.x+matrix[0][0]*x+matrix[0][1]*y,y:origin.y+matrix[1][0]*x+matrix[1][1]*y};
}
module.exports={correction,transform};

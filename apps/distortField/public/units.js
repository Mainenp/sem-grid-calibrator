// One conversion implementation for the API, CSV and browser.
(function(root, factory) {
  if(typeof module==='object' && module.exports) module.exports=factory();
  else root.DistortionUnits=factory();
})(typeof globalThis==='object'?globalThis:this, function() {
  const positive=value=>Number.isFinite(value)&&value>0;
  function convert(value, field, unit='px') {
    if(!Number.isFinite(value)) return null;
    if(unit==='px') return value;
    if(unit==='scanPercent') return positive(field.image?.width)?100*value/field.image.width:null;
    if(unit==='pitchPercent') return positive(field.idealPitch)?100*value/field.idealPitch:null;
    const nm=field.physical?.nanometersPerPixel;
    if(!positive(nm)) return null;
    if(unit==='nm') return value*nm;
    if(unit==='um') return value*nm/1000;
    throw new Error(`Unknown distortion unit: ${unit}`);
  }
  function stats(values, field) {
    return Object.fromEntries(['px','scanPercent','pitchPercent','nm','um'].map(unit=>
      [unit,Object.fromEntries(Object.entries(values).map(([key,value])=>[key,convert(value,field,unit)]))]));
  }
  function attach(field) {
    field.units={denominators:{scanWidthPx:field.image.width,pitchPx:field.idealPitch},
      physicalSource:field.physical.source, total:stats(field.stats,field),
      fitResidual:stats(field.fitResidualStats,field),
      modes:Object.fromEntries(Object.entries(field.decomposition.stats).map(([key,value])=>[key,stats(value,field)]))};
    return field;
  }
  function csvFields(field) {
    const result={physicalScaleSource:field.physical.source,fovMicrometers:field.physical.fovMicrometers};
    for(const [name,values] of Object.entries({total:field.stats,fitResidual:field.fitResidualStats,...field.decomposition.stats})) {
      for(const [suffix,unit] of [['ScanPercent','scanPercent'],['PitchPercent','pitchPercent'],['Nm','nm']]) {
        result[`${name}P95${suffix}`]=convert(values.p95,field,unit);
      }
    }
    return result;
  }
  const csvColumns=Object.keys(csvFields({physical:{source:null,fovMicrometers:null},image:{width:1},idealPitch:1,
    stats:{p95:0},fitResidualStats:{p95:0},decomposition:{stats:Object.fromEntries(['nonlinear','radial','tangential','affine','residual'].map(k=>[k,{p95:0}]))}}));
  return {convert,stats,attach,csvFields,csvColumns};
});

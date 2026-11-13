importScripts('country-label-layout.js');
let geometry=null,revision=0;
self.onmessage=async event=>{
  const data=event.data;
  if(data.type==='geometry'){geometry=data.geometry;return;}
  if(data.type==='cancel'){revision=data.revision;return;}
  revision=data.revision;
  try {
    const labels=await CountryLabelLayout.compute(geometry,data.request,()=>revision!==data.revision);
    if(revision===data.revision)self.postMessage({revision:data.revision,labels});
  }catch(error){if(revision===data.revision)self.postMessage({revision:data.revision,error:error.message});}
};

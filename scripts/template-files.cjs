const fs=require('node:fs/promises'),path=require('node:path');
function directory(key){if(['eu5','hoi4','vic3'].includes(key))return'assets/maps/'+key;if(/^ck3-(867|1066|1178)$/.test(key))return'assets/maps/ck3/'+key.slice(4);throw new Error('未知的地图模板。');}
async function readLookup({key,filename}={}){if(typeof filename!=='string'||!(/^(meta|paint-meta)\.js$/.test(filename)||/^band-\d{1,2}\.js$/.test(filename)))throw new Error('地图验证文件无效。');const root=directory(key),text=await fs.readFile(path.resolve(__dirname,'..',root,'lookup',filename),'utf8');return JSON.parse(text.slice(text.indexOf('=')+1).trim().replace(/;$/,''));}
module.exports={directory,readLookup};

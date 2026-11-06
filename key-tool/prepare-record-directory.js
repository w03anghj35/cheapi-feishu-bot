'use strict';
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
function prepareRecordDirectory(root){
  const source=fs.readFileSync(path.join(__dirname,'..','scripts','prepare-local-data.ps1'),'utf8');
  const command=`& {\n${source}\n} -ProjectRoot '${path.resolve(root).replace(/'/g,"''")}'`;
  const env={...process.env};delete env.PSModulePath; // Windows PowerShell 5 must load its own native modules, not PowerShell 7's.
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],
    {env,windowsHide:true,timeout:15000,encoding:'utf8'});
  return result.status===0;
}
module.exports={prepareRecordDirectory};

'use strict';
// Read-only import of local journals. No decryption, no platform requests, no source writes.
const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');
const {makeRecordTable}=require('../key-tool/record-table');
function readJournal(file){
  const source=fs.readFileSync(file,'utf8');if(!source.endsWith('\n'))throw new Error('Incomplete source journal');
  let sequence=0,rows;
  for(const line of source.trimEnd().split('\n')){
    const envelope=JSON.parse(line);if(createHash('sha256').update(envelope.payload).digest('hex')!==envelope.checksum)throw new Error('Journal checksum failed');
    const snapshot=JSON.parse(envelope.payload);if(snapshot.sequence!==++sequence||!Array.isArray(snapshot.rows))throw new Error('Journal sequence failed');rows=snapshot.rows;
  }
  if(!rows)throw new Error('No journal snapshot');return rows;
}
if(require.main===module){
  try{
    const root=path.resolve(__dirname,'..'),data=path.join(process.env.APPDATA,'CheapiKeyStudio');
    const files=[path.join(data,'operations.journal'),path.join(data,'user-registration','operations.journal'),path.join(data,'group-settings','operations.journal')];
    const before=files.map(f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
    const [tokens,registrations,settings]=files.map(readJournal);
    const after=files.map(f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
    if(before.some((h,i)=>h!==after[i]))throw new Error('Source changed during export; rerun after current operation');
    const result=makeRecordTable(path.join(root,'本机数据')).sync({tokens,registrations,settings});
    if(result.error)throw new Error('Table update failed');
    console.log(JSON.stringify({ok:true,rows:result.rows,tokenOperations:tokens.length,registrations:registrations.length,groupOperations:settings.length,updatedAt:result.updatedAt}));
  }catch{console.error('Export not completed. Preserve source journals and check data directory/source integrity.');process.exitCode=1;}
}
module.exports={readJournal};

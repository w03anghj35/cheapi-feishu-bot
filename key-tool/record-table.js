'use strict';
const fs=require('node:fs');const path=require('node:path');const {createHash,randomUUID}=require('node:crypto');
const HEADERS=['业务类型','创建时间（北京时间）','创建者姓名','姓名来源','状态','目标账号','用户名','分组名称','额度（平台单位）','初始余额（平台单位）','并发数','专属倍率','允许使用分组','错误编号','交付状态','目标用户ID','令牌ID','分组ID','平台管理员ID','创建者身份标识','操作编号','明细编号','最后更新时间（北京时间）','人工核对时间（北京时间）'];
const STATES={pending:'处理中/待核对',unknown:'结果未知/待核对',success:'成功',failed:'失败',reviewed:'已人工核对（不等于成功）'};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=v=>typeof v==='string'?v.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,2000):v==null?'':String(v);
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:'';
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(Date.parse(v)+8*3600000).toISOString().replace('T',' ').replace('Z',''):'';
function buildRows({tokens,registrations,settings}) {
  if(!Array.isArray(tokens)||!Array.isArray(registrations)||!Array.isArray(settings))throw new Error('Ledger source unavailable');
  const rows=[];
  function add(kind,r,extra={}) {
    if(!r||typeof r.requestId!=='string'||!STATES[r.state])throw new Error('Invalid ledger record');
    const actor=r.operator||{};
    rows.push([kind,time(r.at),text(actor.displayName||(actor.source==='feishu-open-id'?'姓名未获取':actor.name||'未记录')),
      actor.nameSource==='feishu-chat-members'?'创建时飞书姓名':actor.nameSource==='feishu-current-member'?'当前飞书姓名（非历史）':actor.source==='self-reported'?'手动填写（未核验）':'未取得姓名',
      STATES[r.state],text(extra.email),text(extra.username),text(extra.groupName),number(extra.quota),number(extra.balance),number(extra.concurrency),
      extra.rate===null?'默认倍率':number(extra.rate),extra.allowed===undefined?'':extra.allowed?'是':'否',text(r.errorCode),
      ({sent:'已发送',pending:'待交付核对',unknown:'交付待核对'})[r.delivery]||'',text(extra.userId),text(extra.keyId),text(extra.groupId),text(r.owner),
      text(actor.name),text(r.requestId),`${kind}:${r.requestId}${extra.detail===undefined?'':':'+extra.detail}`,time(r.updatedAt||r.at),time(r.reviewedAt)]);
  }
  for(const r of tokens)add('令牌创建',r,{groupName:r.group?.customerName||r.group?.originalName,groupId:r.body?.group_id,quota:r.body?.quota,keyId:r.receipt?.id});
  for(const r of registrations)add('用户注册',r,{email:r.body?.email,username:r.body?.username,balance:r.body?.balance,concurrency:r.body?.concurrency,userId:r.receipt?.id});
  for(const r of settings){if(!Array.isArray(r.body?.changes))throw new Error('Invalid group changes');
    r.body.changes.forEach((c,i)=>add('分组设置',r,{userId:r.targetId,groupId:c.groupId,rate:c.rate,allowed:c.allowed,detail:i}));}
  const ids=new Set();for(const row of rows){if(ids.has(row[21]))throw new Error('Duplicate detail');ids.add(row[21]);}
  return rows.sort((a,b)=>a[1].localeCompare(b[1])||a[21].localeCompare(b[21]));
}
function csvCell(v){let s=text(v);if(typeof v==='string'&&/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(rows){return '\ufeff'+[HEADERS,...rows].map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';}
function makeRecordTable(dir,{io=fs,now=()=>new Date().toISOString()}={}) {
  let current={updatedAt:null,rows:0,error:null,folder:dir},loaded=false,broken=false,lastHash=null;
  const known=new Map(),history=path.join(dir,'变化轨迹.jsonl');
  function ensure(){if(!io.existsSync(dir)||!io.lstatSync(dir).isDirectory()||io.lstatSync(dir).isSymbolicLink())throw new Error('Local data directory unavailable');}
  function load(){if(loaded)return;ensure();if(io.existsSync(history)){
    if(io.lstatSync(history).isSymbolicLink()||io.statSync(history).size>20*1024*1024)throw new Error('History unavailable');
    const source=io.readFileSync(history,'utf8');if(source&&!source.endsWith('\n'))throw new Error('Incomplete history');
    for(const line of source.trimEnd().split('\n').filter(Boolean)){const event=JSON.parse(line);
      if(!event||event.version!==1||!Array.isArray(event.row)||event.row.length!==HEADERS.length||event.hash!==digest(event.row)||event.id!==event.row[21])throw new Error('Invalid history');
      known.set(event.id,event.hash);}
  }loaded=true;}
  function atomic(filename,content){const target=path.join(dir,filename),tmp=path.join(dir,`.table-${randomUUID()}.tmp`);let fd;
    if(io.existsSync(target)&&io.lstatSync(target).isSymbolicLink())throw new Error('Unsafe table target');
    try{fd=io.openSync(tmp,'wx',0o600);io.writeFileSync(fd,content,'utf8');io.fsyncSync(fd);io.closeSync(fd);fd=undefined;io.renameSync(tmp,target);}
    finally{if(fd!==undefined)io.closeSync(fd);if(io.existsSync(tmp))io.unlinkSync(tmp);}
  }
  return {state:()=>({...current}),sync(source){
    try{
      ensure();if(io.existsSync(history)&&io.lstatSync(history).isSymbolicLink())throw new Error('Unsafe history');
      if(broken)throw new Error('History requires review');
      try{load();}catch(error){broken=true;throw error;}
      const rows=buildRows(source),hash=digest(rows);
      // Source deletion must not silently erase the previously exported history.
      const present=new Set(rows.map(r=>r[21]));for(const key of known.keys())if(!present.has(key))throw new Error('Ledger rows disappeared');
      if(hash===lastHash&&!current.error)return {...current};
      const at=now(),events=[];
      for(const row of rows){const rowHash=digest(row);if(known.get(row[21])!==rowHash)events.push({version:1,at,id:row[21],kind:known.has(row[21])?'状态或内容更新':'首次收录',hash:rowHash,row});}
      if(events.length){
        const bytes=Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n');
        if((io.existsSync(history)?io.statSync(history).size:0)+bytes.length>20*1024*1024)throw new Error('History full');
        let fd;try{fd=io.openSync(history,'a',0o600);let offset=0;while(offset<bytes.length){const n=io.writeSync(fd,bytes,offset,bytes.length-offset);if(!Number.isInteger(n)||n<=0)throw new Error('Short write');offset+=n;}io.fsyncSync(fd);io.closeSync(fd);fd=undefined;}
        catch(error){broken=true;throw error;}finally{if(fd!==undefined)io.closeSync(fd);}
        for(const event of events)known.set(event.id,event.hash);
      }
      atomic('创建记录.json',JSON.stringify({version:1,updatedAt:at,headers:HEADERS,rows},null,2));
      atomic('创建记录.csv',csv(rows));
      lastHash=hash;current={updatedAt:at,rows:rows.length,error:null,folder:dir};
    }catch{current={...current,error:broken?'轨迹文件异常，请保留原件检查；原业务账本不受影响。':'表格未更新，请关闭占用文件的Excel并检查磁盘/目录权限；原业务账本不受影响。'};}
    return {...current};
  }};
}
module.exports={HEADERS,buildRows,csv,makeRecordTable};

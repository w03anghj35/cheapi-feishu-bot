'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const ACTIONS = Object.freeze({
  'admin-refresh':'读取令牌分组', 'admin-save-groups':'发布令牌分组',
  'admin-login':'打开平台登录', 'admin-complete-login':'保存平台授权', 'admin-recover-authorization':'恢复平台授权',
  'admin-feishu-connect':'启用飞书连接', 'admin-feishu-disconnect':'暂停飞书连接',
  'admin-feishu-save-credentials':'保存飞书凭据', 'admin-feishu-start-owner-binding':'发起管理员绑定',
  'admin-feishu-confirm-owner':'确认管理员绑定', 'admin-feishu-start-group-binding':'发起目标群绑定',
  'admin-feishu-confirm-group':'确认目标群绑定', 'admin-feishu-save-policy':'保存群策略',
  'admin-group-settings-refresh':'读取倍率分组', 'admin-group-settings-save':'发布倍率分组',
  'admin-group-settings-records':'读取倍率设置记录', 'admin-group-settings-review':'核对倍率设置记录',
  'admin-registration-records':'读取注册记录', 'admin-registration-review':'核对注册记录',
  'admin-records':'读取令牌记录', 'admin-record':'读取令牌详情', 'admin-secret':'显示令牌密钥', 'admin-copy-secret':'复制令牌密钥',
  'admin-channel-monitor-rename':'保存渠道名称', 'admin-channel-monitor-open':'打开渠道登录窗口', 'admin-channel-monitor-check':'读取渠道金额',
  'admin-channel-login-save':'保存渠道自动登录', 'admin-channel-login-pause':'暂停渠道自动登录', 'admin-channel-login-clear':'清除渠道自动登录',
  'admin-channel-alert-save':'保存低余额邮件提醒', 'admin-channel-alert-pause':'暂停低余额邮件提醒', 'admin-channel-alert-clear':'清除低余额邮件提醒',
  'admin-channel-alert-test':'发送渠道余额测试邮件',
  'admin-channel-access-save':'保存成员渠道授权', 'admin-channel-access-update':'更新成员渠道授权',
  'admin-channel-access-revoke':'撤销成员渠道授权',
  'admin-user-ownership-save-name':'按姓名保存用户归属',
  'admin-user-ownership-link':'核对并绑定飞书成员归属',
  'admin-daily-usage-preview':'预览归属每日用量', 'admin-daily-usage-enable':'启用并发布每日用量群表',
  'admin-daily-usage-pause':'暂停每日用量群表', 'admin-daily-usage-now':'立即更新每日用量群表',
  'admin-daily-usage-review-absent':'人工核对首次群卡片未见并暂停',
  'admin-daily-usage-backfill-current-month':'补采本月已结束日期用量',
  'admin-daily-usage-history-export':'导出历史用量 Excel',
  'admin-account-schedule-snapshot':'读取平台账号与计划', 'admin-account-schedule-create':'保存账号定时计划',
  'admin-account-schedule-cancel':'取消账号定时步骤', 'admin-account-schedule-reconcile':'只读核对账号开关'
});
const STAGES = Object.freeze({ operation:'执行操作', identity:'核验管理员授权', groups:'读取平台分组', validation:'校验分组名称',
  'recheck-identity':'再次核验账户', storage:'保存本机配置', complete:'操作完成' });
const CODES = new Set(['INPUT','AUTH','DENIED','POLICY','BUSY','STORAGE','DUPLICATE','UNKNOWN','HTTP','API','NETWORK','SCHEMA','CONFLICT','LIMIT','ROUTE','STOP','CONFIG','CONNECT','TIMEOUT','OPERATION_ERROR']);
const MAX_BYTES=4*1024*1024, MAX_ROWS=500;
function safe(row) {
  if (!row || !/^[a-f0-9-]{36}$/.test(row.id) || !Object.hasOwn(ACTIONS,row.action) || !Object.hasOwn(STAGES,row.stage) ||
      !['running','success','failure'].includes(row.status) || !Number.isFinite(Date.parse(row.at)) ||
      !Number.isFinite(Date.parse(row.startedAt)) || !Number.isSafeInteger(row.durationMs) || row.durationMs<0)
    throw new Error('invalid log record');
  return {id:row.id,action:row.action,stage:row.stage,status:row.status,at:row.at,startedAt:row.startedAt,durationMs:row.durationMs,
    code:CODES.has(row.code)?row.code:null,httpStatus:Number.isInteger(row.httpStatus)&&row.httpStatus>=100&&row.httpStatus<=599?row.httpStatus:null};
}
function makeAdminOperationLog(dir, {io=fs, now=()=>Date.now(), memory=false}={}) {
  const file=path.join(dir,'admin-operations.jsonl'), context=new AsyncLocalStorage(), rows=new Map(), active=new Set();
  let storageError=false, bytes=0;
  function remember(row) { rows.delete(row.id); rows.set(row.id,row); while(rows.size>MAX_ROWS)rows.delete(rows.keys().next().value); }
  try {
    if(!memory&&io.existsSync(file)) {
      bytes=io.statSync(file).size;if(bytes>MAX_BYTES)throw new Error('size');
      const source=io.readFileSync(file,'utf8');if(source&&!source.endsWith('\n'))throw new Error('incomplete');
      for(const line of source.trimEnd().split('\n').filter(Boolean))remember(safe(JSON.parse(line)));
    }
  } catch {storageError=true;}
  function append(row) {
    const clean=safe(row);remember(clean);if(memory)return;
    if(storageError)return;
    let fd;
    try {
      const data=Buffer.from(JSON.stringify(clean)+'\n');if(bytes+data.length>MAX_BYTES)throw new Error('full');
      io.mkdirSync(dir,{recursive:true});fd=io.openSync(file,'a',0o600);
      for(let offset=0;offset<data.length;){const n=io.writeSync(fd,data,offset,data.length-offset);if(!Number.isInteger(n)||n<=0||n>data.length-offset)throw new Error('write');offset+=n;}
      io.fsyncSync(fd);io.closeSync(fd);fd=undefined;bytes+=data.length;
    } catch {storageError=true;} finally {if(fd!==undefined){try{io.closeSync(fd);}catch{storageError=true;}}}
  }
  function step(stage) {
    const current=context.getStore();if(!current||!Object.hasOwn(STAGES,stage))return;
    current.stage=stage;append({...current,status:'running',at:new Date(now()).toISOString(),durationMs:Math.max(0,now()-Date.parse(current.startedAt))});
  }
  return { step,
    state() { return {storageError,limit:MAX_ROWS,items:[...rows.values()].reverse().map(r=>({...r,
      status:r.status==='running'&&!active.has(r.id)?'interrupted':r.status,actionLabel:ACTIONS[r.action],stageLabel:STAGES[r.stage]}))}; },
    async run(action,fn) {
      if(!Object.hasOwn(ACTIONS,action))return {data:await fn()};
      const row={id:randomUUID(),action,stage:'operation',startedAt:new Date(now()).toISOString()};active.add(row.id);
      return context.run(row,async()=>{
        step('operation');
        try {
          const data=await fn();append({...row,status:'success',stage:'complete',at:new Date(now()).toISOString(),durationMs:Math.max(0,now()-Date.parse(row.startedAt))});
          return {data,operationId:row.id,logWarning:storageError};
        } catch(error) {
          append({...row,status:'failure',at:new Date(now()).toISOString(),durationMs:Math.max(0,now()-Date.parse(row.startedAt)),code:CODES.has(error?.code)?error.code:'OPERATION_ERROR',httpStatus:error?.httpStatus});
          return {error,failed:true,operationId:row.id,logWarning:storageError};
        } finally {active.delete(row.id);}
      });
    }
  };
}
module.exports={makeAdminOperationLog};

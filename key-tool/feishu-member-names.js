'use strict';
const { createHash } = require('node:crypto');
const fingerprint = openId => `飞书用户#${createHash('sha256').update(openId).digest('hex').slice(0,20)}`;
const validName = name => typeof name === 'string' && !!name.trim() && name.length <= 100 && !/[\x00-\x1f\x7f]/.test(name);
class FeishuMemberNames {
  constructor({ getScope, now=()=>Date.now(), waitMs=2000 }) {
    Object.assign(this,{getScope,now,waitMs});this.scope=null;this.names=new Map();this.identityNames=new Map();this.pending=null;
    this.retryAt=0;this.updatedAt=null;this.reason='not-loaded';this.version=0;
  }
  current() {
    const next=this.getScope();
    if(!next || !/^oc_[\w-]{8,128}$/.test(next.groupId)||!next.appId||!next.client?.listGroupMembers) {
      if(this.scope){this.version++;this.scope=null;this.names.clear();this.identityNames.clear();this.updatedAt=null;this.retryAt=0;}
      this.reason='unavailable';return null;
    }
    if(this.scope?.client!==next.client||this.scope?.groupId!==next.groupId||this.scope?.appId!==next.appId){
      this.version++;this.scope=next;this.names.clear();this.identityNames.clear();this.retryAt=0;this.updatedAt=null;this.reason='not-loaded';
    }
    return this.scope;
  }
  state(){this.current();return {reason:this.reason,updatedAt:this.updatedAt,count:this.names.size};}
  lookup(identity, groupId) {
    const scope=this.current();if(!scope||groupId!==scope.groupId||this.now()>=this.retryAt)return null;
    return this.names.get(identity)||null;
  }
  lookupOwnershipIdentity(identity, groupId) {
    const scope=this.current();if(!scope||groupId!==scope.groupId||this.now()>=this.retryAt||
      typeof identity!=='string'||!/^[a-f0-9]{64}$/.test(identity))return null;
    return this.identityNames.get(identity)||null;
  }
  decorateOwnershipIdentities(rows, groupId) {
    if(!Array.isArray(rows))throw new Error('invalid ownership identities');
    return rows.map(row=>{
      const current=this.lookupOwnershipIdentity(row.identity,groupId);
      return current?{...row,currentFeishuName:current.displayName}:row;
    });
  }
  async refresh() {
    const scope=this.current();if(!scope)return this.state();
    if(this.now()<this.retryAt)return this.state();
    if(!this.pending){
      const version=this.version;
      this.reason='loading';
      this.pending=this.load(scope,version).finally(()=>{this.pending=null;});
    }
    let timeout;
    try {await Promise.race([this.pending,new Promise(resolve=>{timeout=setTimeout(resolve,this.waitMs);})]);}
    finally{clearTimeout(timeout);}
    return this.state();
  }
  async load(scope,version) {
    const names=new Map(),identityNames=new Map(),tokens=new Set(),seen=new Set();let token,deadline=this.now()+8000;
    const current=()=>{this.current();return version===this.version;};
    try {
      for(let page=0;page<20;page++) {
        if(!current())return;
        if(this.now()>deadline)throw {code:'TIMEOUT'};
        const data=await scope.client.listGroupMembers(scope.groupId,token);
        if(!current())return;
        if(this.now()>deadline)throw {code:'TIMEOUT'};
        if(!data||!Array.isArray(data.items)||typeof data.has_more!=='boolean')throw {code:'SCHEMA'};
        for(const row of data.items){
          if(row?.member_id_type!=='open_id'||typeof row.member_id!=='string'||!/^ou_[\w-]{4,252}$/.test(row.member_id))throw {code:'SCHEMA'};
          const key=fingerprint(row.member_id);
          if(seen.has(key))throw {code:'SCHEMA'};seen.add(key);
          if(validName(row.name)){
            const info={displayName:row.name.trim(),nameSource:'feishu-chat-members',nameFetchedAt:new Date(this.now()).toISOString()};
            names.set(key,info);
            identityNames.set(createHash('sha256').update(row.member_id).digest('hex'),info);
          }
          if(seen.size>5000)throw {code:'LIMIT'};
        }
        if(!data.has_more){this.names=names;this.identityNames=identityNames;this.updatedAt=new Date(this.now()).toISOString();this.retryAt=this.now()+300000;this.reason='ready';return;}
        if(typeof data.page_token!=='string'||!data.page_token||data.page_token.length>4096||tokens.has(data.page_token))throw {code:'SCHEMA'};
        token=data.page_token;tokens.add(token);
      }
      throw {code:'LIMIT'};
    } catch(error) {
      if(!current())return;
      this.names.clear();this.identityNames.clear();this.updatedAt=null;this.retryAt=this.now()+60000;
      this.reason=error?.code==='DENIED'?'permission':error?.code==='LIMIT'?'limit':'failed';
    }
  }
  async actor(openId,groupId) {
    await this.refresh();const identity=fingerprint(openId);return this.lookup(identity,groupId);
  }
  decorate(record) {
    if(record?.operator?.source!=='feishu-open-id'||record.operator.displayName)return record;
    const name=this.lookup(record.operator.name,record.feishuGroupId);
    return name ? {...record,operator:{...record.operator,...name,nameSource:'feishu-current-member'}} : record;
  }
}
module.exports={FeishuMemberNames,fingerprint,validName};

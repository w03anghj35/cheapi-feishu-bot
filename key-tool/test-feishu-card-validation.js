'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFormStructure } = require('./feishu-card-validation');
const { requestCard } = require('./feishu-request-cards');
const { formValues, initialDraft } = require('./feishu-group-settings');
const nodes = n => [n,...['elements','columns','actions'].flatMap(k=>(n[k]||[]).flatMap(nodes))];
function session(page=0) {
  const groupPreview = { user:{id:8,email:'fixture@example.invalid',restrict_public_groups:false,allowed_groups:[1],group_rates:{1:0.8}},
    groups:Array.from({length:7},(_,i)=>({id:i+1,name:`已发布分组${i+1} <img>`,exclusive:i%2===0,rate:1})) };
  return {state:'settings-form',groupPreview,settingsDraft:initialDraft(groupPreview),settingsPage:page,requestId:'fixture',cardToken:'fixture_nonce'};
}
test('JSON 1.0 rejects the previously used form/div hierarchy',()=>{
  const card = {elements:[{tag:'form',name:'fixture_form',elements:[{tag:'div',text:{tag:'plain_text',content:'fixture group'}},
    {tag:'button',name:'submit',action_type:'form_submit'}]}]};
  assert.throws(()=>validateFormStructure(card),/unsupported direct form child/);
});
for(const page of [0,1]) test(`rate form page ${page+1} has published names on left and real inputs on right`,()=>{
  const s=session(page),card=requestCard(s,20),form=card.elements.find(n=>n.tag==='form');
  validateFormStructure(card);
  const groups=s.groupPreview.groups.slice(page*5,page*5+5);
  assert.equal(form.elements.some(n=>n.tag==='div'),false);
  for(const g of groups) {
    const row=form.elements.find(n=>n.tag==='column_set'&&n.columns[1].elements.some(e=>e.name===`rate_${g.id}`));
    assert.ok(row);assert.equal(row.columns[0].elements[0].text.tag,'plain_text');
    assert.ok(row.columns[0].elements[0].text.content.includes(g.name));
    assert.equal(row.columns[1].elements[0].tag,'input');
    assert.equal(row.columns[1].elements[0].name,`rate_${g.id}`);
  }
  assert.equal(nodes(form).filter(n=>n.tag==='input').length,groups.length);
  const values=Object.fromEntries(groups.flatMap(g=>[[`rate_${g.id}`,'0.9'],...(g.exclusive?[[`allow_${g.id}`,'yes']]:[])]));
  assert.equal(formValues(s,values).length,groups.length);
  assert.ok(form.elements.some(n=>n.action_type==='form_submit'));
  assert.ok(Buffer.byteLength(JSON.stringify(card),'utf8')<28000);
});
test('account and registration form contracts remain valid; nested form and repeated field fail',()=>{
  for(const state of ['settings-user','register-form']) validateFormStructure(requestCard({state,registration:{},requestId:'fixture',cardToken:'fixture'},20));
  const s=session(),card=requestCard(s,20),form=card.elements.find(n=>n.tag==='form');
  form.elements.push({tag:'input',name:'rate_1'});assert.throws(()=>validateFormStructure(card),/duplicate/);
  assert.throws(()=>validateFormStructure({elements:[{tag:'column_set',columns:[{tag:'column',elements:[{tag:'form',name:'x',elements:[]}]}]}]}),/placement/);
});

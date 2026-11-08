'use strict';
(() => {
  const el = id => document.getElementById(id);
  let current = { people: [], channels: [], storageError: false }, busy = false, generation = 0;
  const status = message => { el('channel-access-status').textContent = message; };
  const make = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  function channelChecks(selected = [], prefix = '') {
    const wrap = make('div'); wrap.className = 'channel-access-options';
    for (const channel of current.channels) {
      const label = make('label'); const box = make('input');
      box.type = 'checkbox'; box.value = channel.id; box.name = prefix + 'channel-access-channel';
      box.checked = selected.includes(channel.id);
      label.append(box, document.createTextNode(`${channel.name}（${channel.metric}）`)); wrap.append(label);
    }
    return wrap;
  }
  const draftChannels = new Map();
  function render() {
    el('channel-access-save').disabled = busy || current.storageError;
    const selected = [...el('channel-access-options').querySelectorAll('input:checked')].map(box => box.value);
    if ([...el('channel-access-options').querySelectorAll('input')].map(box => box.value).join('|') !==
        current.channels.map(channel => channel.id).join('|'))
      el('channel-access-options').replaceChildren(...channelChecks(selected).childNodes);
    const area = el('channel-access-people'); area.replaceChildren();
    if (!current.people.length) { area.append(make('p', '暂无授权。保存前请核对成员稳定身份。')); return; }
    for (const person of current.people) {
      const card = make('article'); card.className = 'channel-access-person';
      card.append(make('strong', `${person.name} · ${person.enabled ? '已授权' : '已撤销'}`));
      card.append(make('p', `身份摘要：${person.identityHint}`));
      const checks = channelChecks(draftChannels.get(person.id) ?? person.channelIds, `access-${person.id}-`);
      checks.addEventListener('change', () => draftChannels.set(person.id,
        [...checks.querySelectorAll('input:checked')].map(box => box.value)));
      card.append(checks);
      const actions = make('div'); actions.className = 'channel-buttons';
      const update = make('button', person.enabled ? '更新可见渠道' : '重新启用所选渠道'); update.type = 'button';
      update.addEventListener('click', () => void act('update', { id: person.id, channelIds:
        [...checks.querySelectorAll('input:checked')].map(box => box.value) })); actions.append(update);
      if (person.enabled) {
        const preview = make('button', '只读预览'); preview.type = 'button';
        preview.addEventListener('click', () => void showPreview(person.id)); actions.append(preview);
        const revoke = make('button', '撤销授权'); revoke.type = 'button';
        revoke.addEventListener('click', () => {
          if (window.confirm(`确认撤销“${person.name}”的渠道查看授权？`)) void act('revoke', person.id);
        }); actions.append(revoke);
      }
      card.append(actions); area.append(card);
    }
  }
  async function refresh() {
    const requestGeneration = generation;
    try {
      const result = await window.groupAdmin.channelAccessState();
      if (!result.ok) throw new Error(result.message);
      if (requestGeneration !== generation) return;
      current = result.data; render();
      status(current.storageError ? '加密授权记录不可用；查询保持关闭。' :
        `已读取 ${current.people.length} 位成员的授权配置。当前尚未连接微信或 AI。`);
    } catch (error) { if (requestGeneration === generation) status(error.message); }
  }
  async function act(kind, input) {
    if (busy) return;
    busy = true; generation++; el('channel-access-save').disabled = true;
    try {
      const method = { save: 'channelAccessSave', update: 'channelAccessUpdate', revoke: 'channelAccessRevoke' }[kind];
      const result = await window.groupAdmin[method](input);
      if (!result.ok) throw new Error(result.message);
      if (kind === 'update' || kind === 'revoke') draftChannels.delete(input.id ?? input);
      current = { ...current, ...result.data }; render();
      if (kind === 'save') {
        el('channel-access-form').reset();
        for (const box of el('channel-access-options').querySelectorAll('input:checked')) box.checked = false;
      }
      el('channel-access-preview').textContent = '请选择一个已授权成员预览。';
      status(kind === 'save' ? '授权已加密保存；当前只供本机预览，尚未接入聊天。' :
        kind === 'update' ? '可见渠道已更新。' : '授权已撤销。');
    } catch (error) { status(error.message); }
    finally { busy = false; render(); }
  }
  async function showPreview(id) {
    const area = el('channel-access-preview'); area.textContent = '正在读取本机快照…';
    try {
      const result = await window.groupAdmin.channelAccessPreview(id);
      if (!result.ok) throw new Error(result.message);
      area.replaceChildren();
      for (const row of result.data) area.append(make('p', `${row.name} · ${row.metric}：${row.status === 'ok' ? row.display ?? row.value : '本次未取得有效金额'}${row.status === 'ok' ? `（${row.checkedAt}）` : ''}`));
      if (!result.data.length) area.textContent = '此成员没有可见渠道。';
    } catch (error) { area.textContent = error.message; }
  }
  el('channel-access-refresh').onclick = () => void refresh();
  el('channel-access-form').addEventListener('submit', event => {
    event.preventDefault();
    void act('save', { name: el('channel-access-name').value, botAccountId: el('channel-access-bot').value,
      senderId: el('channel-access-sender').value,
      channelIds: [...el('channel-access-options').querySelectorAll('input:checked')].map(box => box.value) });
  });
  window.addEventListener('admin-view-change', event => { if (event.detail.view === 'channel-access') void refresh(); });
  void refresh();
})();

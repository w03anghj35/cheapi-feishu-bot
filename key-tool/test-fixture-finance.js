'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { CHANNELS } = require('./channel-monitor');

async function verifyFinanceUI({ channelMonitor, openAdminWindow }) {
  channelMonitor.stop();
  const admin = await openAdminWindow();
  const run = code => admin.webContents.executeJavaScript(code, false);
  const wait = async code => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await run(code)) return;
      await delay(50);
    }
    throw new Error('Finance UI fixture did not reach its expected state');
  };
  await run('document.querySelector("[data-admin-target=channel-monitor]").click()');
  await wait('!document.getElementById("channel-monitor").hidden');
  await wait('document.getElementById("finance-api-status").textContent.includes("接口保持关闭")');
  assert.equal(await run('document.getElementById("finance-api-enable").disabled'), true);
  assert.equal(await run('document.getElementById("finance-api-copy-token").disabled'), true);
  assert.equal(await run('!!window.financeMetrics && typeof window.financeMetrics.calculateMonitoredSuppliers === "function"'), true);
  assert.equal(await run('document.querySelectorAll("#channel-monitor-rows .channel-monitor-card").length'), 5);
  assert.equal(await run('document.querySelectorAll("#channel-monitor-rows .channel-factor-input").length'), 5);
  assert.equal(await run('document.getElementById("channel-converted-total").textContent'), '—');
  await run(`(() => {
    const card = document.querySelector('[data-channel-id=points-ip]');
    card.querySelector('.channel-factor-input').value = '1.6';
    card.querySelector('.channel-conversion button').click();
  })()`);
  await wait('document.querySelector("[data-channel-id=points-ip] .channel-factor-status").textContent.includes("已保存倍率 1.6")');
  for (const id of CHANNELS.map(row => row.id).slice(1)) {
    const response = await run(`window.groupAdmin.channelFactorSave({id:${JSON.stringify(id)},rate:'1.6'})`);
    assert.equal(response.ok, true);
  }
  assert.equal((await run('window.groupAdmin.channelFactorState()')).data.factors.filter(row => row.rate === '1.6').length, 5);
  const now = new Date().toISOString();
  const snapshot = channelMonitor.state().map((row, index) => ({ ...row,
    status: 'ok', display: ['15,521.08661469','999.197934825','$25,927.09','$15,479.30','¥100.25'][index], successAt: now }));
  for (const row of snapshot) channelMonitor.rows.set(row.id, { ...row });
  const protectedState = await run('window.groupAdmin.channelConvertedState()');
  assert.equal(protectedState.ok, true);
  assert.equal(protectedState.data.totalCny, '92843.07927922');
  assert.equal(protectedState.data.suppliers.length, 5);
  admin.webContents.send('key-tool:channel-monitor-state', snapshot);
  await wait('document.getElementById("channel-converted-total").textContent === "¥92843.07927922"');
  assert.equal(await run('document.querySelectorAll(".channel-converted-value").length'), 5);
  assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
  admin.setSize(1040, 820);
  await delay(100);
  await run('document.querySelector("[data-channel-id=points-ip] .channel-settings").open = true');
  await delay(100);
  const geometry = await run(`(() => {
    const card = document.querySelector('[data-channel-id=points-ip]');
    const conversion = card.querySelector('.channel-conversion').getBoundingClientRect();
    const settings = card.querySelector('.channel-settings').getBoundingClientRect();
    const next = card.nextElementSibling.getBoundingClientRect();
    return { conversionBottom: conversion.bottom, settingsTop: settings.top,
      settingsBottom: settings.bottom, cardBottom: card.getBoundingClientRect().bottom, nextTop: next.top };
  })()`);
  assert.ok(geometry.settingsTop >= geometry.conversionBottom &&
    geometry.cardBottom >= geometry.settingsBottom && geometry.nextTop >= geometry.cardBottom,
  `channel conversion overlaps settings or next card: ${JSON.stringify(geometry)}`);
  const output = path.join(__dirname, '..', 'outputs');
  fs.mkdirSync(output, { recursive: true });
  try { fs.writeFileSync(path.join(output, 'channel-factor-desktop-fixture.png'), (await admin.webContents.capturePage()).toPNG()); }
  catch { /* Some GPU/remote sessions cannot capture; geometry and DOM remain asserted. */ }
  admin.setSize(480, 850);
  await delay(100);
  assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
  try { fs.writeFileSync(path.join(output, 'channel-factor-narrow-fixture.png'), (await admin.webContents.capturePage()).toPNG()); }
  catch { /* Capture is auxiliary, not a business-flow verdict. */ }
  await run('document.getElementById("channel-converted-title").scrollIntoView()');
  await delay(100);
  try { fs.writeFileSync(path.join(output, 'channel-factor-total-fixture.png'), (await admin.webContents.capturePage()).toPNG()); }
  catch { /* Snapshot is optional; API, DOM and geometry remain asserted. */ }
  const stale = snapshot.map((row, index) => index === 0 ? { ...row, status: 'failed' } : row);
  admin.webContents.send('key-tool:channel-monitor-state', stale);
  await wait('document.getElementById("channel-converted-total").textContent === "—"');
  assert.equal(await run('document.querySelector("[data-channel-id=points-ip] .channel-converted-value").textContent.includes("—")'), true);
  return true;
}

module.exports = { verifyFinanceUI };

'use strict';
const { BrowserWindow, session } = require('electron');
const { observationScript } = require('./channel-monitor');

function allowed(channel, url) {
  try { const next = new URL(url); return next.protocol === 'https:' && next.origin === channel.origin; }
  catch { return false; }
}
// Each site's public sign-in form has an independent, exact selector contract.
// The page handles submission; no token/cookie is returned to Node.
const LOGIN_FORMS = Object.freeze({
  'points-ip': Object.freeze({ paths: ['/auth', '/auth/'], emailSelector: '#auth-email', passwordSelector: '#auth-password', step: 'credentials' }),
  'points-anna': Object.freeze({ paths: ['/auth', '/auth/'], emailSelector: '#auth-email', passwordSelector: '#auth-password', step: 'credentials' }),
  'spent-ccrouter': Object.freeze({ paths: ['/login', '/login/'], emailSelector: '#email', passwordSelector: '#password' }),
  'spent-aerorelay': Object.freeze({ paths: ['/', '/dashboard', '/usage', '/login'], emailSelector: '#login-email', passwordSelector: '#login-password', inlineHandler: 'handleLogin(event)' }),
  'balance-juxiang': Object.freeze({ paths: ['/sign-in'], emailSelector: 'input[name="username"]', accountType: 'text', passwordSelector: 'input[name="password"]' })
});
function channelLoginScript(channel, credentials) {
  const spec = LOGIN_FORMS[channel.id];
  if (!spec) return 'false';
  const submit = credentials !== null;
  return `(() => {
    if (location.origin !== ${JSON.stringify(channel.origin)} || location.protocol !== 'https:' ||
        !${JSON.stringify(spec.paths)}.includes(location.pathname)) return false;
    const email = document.querySelector(${JSON.stringify(spec.emailSelector)});
    const password = document.querySelector(${JSON.stringify(spec.passwordSelector)});
    const visible = node => !!(node && node.getClientRects().length);
    const form = email?.form;
    const buttons = form ? [...form.querySelectorAll('button[type="submit"]')].filter(visible) : [];
    const button = buttons[0];
    if (!visible(email) || !visible(password) || buttons.length !== 1 ||
        email.type !== ${JSON.stringify(spec.accountType || 'email')} || password.type !== 'password' ||
        email.form !== password.form || button.form !== form || button.disabled ||
        button.getAttribute('aria-disabled') === 'true' ||
        (${JSON.stringify(spec.step || null)} && form.dataset.step !== ${JSON.stringify(spec.step || null)}) ||
        (${JSON.stringify(spec.inlineHandler || null)} &&
          (form.getAttribute('onsubmit') !== ${JSON.stringify(spec.inlineHandler || null)} || typeof window.handleLogin !== 'function')) ||
        [...document.querySelectorAll('input, iframe, [data-cf-turnstile], .cf-turnstile, [data-sitekey]')].some(node => visible(node) &&
          (node.tagName === 'IFRAME' || node.type === 'checkbox' ||
           node.hasAttribute?.('data-cf-turnstile') || node.hasAttribute?.('data-sitekey') ||
           node.classList?.contains('cf-turnstile') ||
           /captcha|verify|challenge|totp|otp|mfa|2fa/i.test([node.id, node.name, node.src, node.placeholder].join(' '))))) return false;
    if (!${submit}) return true;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    for (const [input, value] of [[email, ${JSON.stringify(credentials?.email || '')}], [password, ${JSON.stringify(credentials?.password || '')}]]) {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    button.click();
    password.value = '';
    return true;
  })()`;
}
const aeroLoginScript = channelLoginScript;
function aeroDashboardNavigationScript(channel) {
  return `(() => { // AERO_DASHBOARD_NAV
    if (location.origin !== ${JSON.stringify(channel.origin)} || !document.querySelector('#app')) return false;
    const links = [...document.querySelectorAll('nav a[href]')].filter(node => {
      if (!node.getClientRects().length) return false;
      try { const url = new URL(node.href, location.href);
        return url.origin === ${JSON.stringify(channel.origin)} && url.pathname === '/dashboard'; }
      catch { return false; }
    });
    if (links.length !== 1) return false;
    links[0].click();
    return true;
  })()`;
}
function aeroPublicLoginRouteScript(channel) {
  return `(() => { // AERO_PUBLIC_LOGIN_ROUTE
    if (location.origin !== ${JSON.stringify(channel.origin)} ||
        !${JSON.stringify(LOGIN_FORMS['spent-aerorelay'].paths)}.includes(location.pathname)) return false;
    const home = document.querySelector('#page-home');
    const login = document.querySelector('#page-login');
    const form = document.querySelector('#login-form');
    if (!home?.getClientRects().length || !home.classList.contains('active') ||
        !login || !form || form.getAttribute('onsubmit') !== 'handleLogin(event)' ||
        typeof window.navigateTo !== 'function') return false;
    window.navigateTo('login');
    return true;
  })()`;
}
function createChannelHost({ isClosing = () => false, BrowserWindowImpl = BrowserWindow, sessionImpl = session,
  autoLogin = null, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const windows = new Map();
  const loginGeneration = new Map();
  const autoLoginBusy = new Set();
  const formUnavailable = new Set();
  const autoLoginSuspended = new Set();
  function create(channel) {
    const prior = windows.get(channel.id);
    if (prior && !prior.isDestroyed()) return prior;
    const partition = `persist:channel-monitor-${channel.id}`;
    const channelSession = sessionImpl.fromPartition(partition);
    channelSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    const window = new BrowserWindowImpl({ width: 1120, height: 820, minWidth: 650, minHeight: 550, show: false,
      title: `渠道登录 · ${channel.origin}`, backgroundColor: '#f5f5f3',
      webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false,
        webSecurity: true, allowRunningInsecureContent: false } });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!allowed(channel, url)) event.preventDefault(); });
    window.webContents.on('will-redirect', (event, url) => { if (!allowed(channel, url)) event.preventDefault(); });
    window.on('close', event => { if (!isClosing()) { event.preventDefault(); window.hide(); } });
    window.on('closed', () => { if (windows.get(channel.id) === window) windows.delete(channel.id); });
    windows.set(channel.id, window);
    return window;
  }
  async function load(channel, { visible = false } = {}) {
    const window = create(channel);
    if (visible) { window.show(); window.focus(); }
    if (!allowed(channel, window.webContents.getURL()) || !window.webContents.getURL())
      await window.loadURL(channel.origin + channel.path);
    return window;
  }
  async function observe(channel, { userRequested = false } = {}) {
    const window = create(channel);
    if (window.isVisible() && !userRequested) return { status: 'user-browsing' };
    const currentURL = window.webContents.getURL();
    let onTargetPage = false;
    try { onTargetPage = allowed(channel, currentURL) && new URL(currentURL).pathname === channel.path; } catch { /* Navigate to the fixed page. */ }
    let inAppNavigation = false;
    if (channel.id === 'spent-aerorelay' && allowed(channel, currentURL) && !onTargetPage) {
      try { inAppNavigation = await window.webContents.executeJavaScript(aeroDashboardNavigationScript(channel), true) === true; }
      catch { /* No browser state is exposed on navigation failure. */ }
    }
    // After manual sign-in, inspect the existing target page before reloading.
    const recoveringPage = userRequested && formUnavailable.has(channel.id) && onTargetPage;
    if (!inAppNavigation && (!onTargetPage || (!window.isVisible() && !recoveringPage && channel.id !== 'spent-aerorelay'))) {
      let timer;
      try {
        await Promise.race([window.loadURL(channel.origin + channel.path),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('navigation timeout')), 25000); })]);
      } finally { clearTimeout(timer); }
    }
    let previous = null, loginSamples = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (window.isDestroyed()) throw new Error('window closed');
      if (window.isVisible() && !userRequested) return { status: 'user-browsing' };
      const result = await window.webContents.executeJavaScript(observationScript(channel), true);
      if (!result || result.origin !== channel.origin) return { status: 'unavailable' };
      if (result.login) {
        if (++loginSamples >= 8) {
          if (window.isVisible() || !autoLogin || autoLoginBusy.has(channel.id) || autoLoginSuspended.has(channel.id))
            return { status: 'login-required' };
          if (!autoLogin.available?.(channel.id)) return { status: 'login-required' };
          let formReady = false;
          try { formReady = await window.webContents.executeJavaScript(channelLoginScript(channel, null), true) === true; }
          catch { /* Untrusted page or navigation changed. */ }
          if (!formReady && channel.id === 'spent-aerorelay') {
            let loginRouteOpened = false;
            try { loginRouteOpened = await window.webContents.executeJavaScript(aeroPublicLoginRouteScript(channel), true) === true; }
            catch { /* Stay on the site and leave credentials untouched. */ }
            if (loginRouteOpened) for (let i = 0; i < 6 && !formReady; i++) {
              await wait(250);
              if (window.isDestroyed() || window.isVisible()) break;
              try { formReady = await window.webContents.executeJavaScript(channelLoginScript(channel, null), true) === true; }
              catch { /* The page may still be changing. */ }
            }
          }
          if (!formReady) { formUnavailable.add(channel.id); return { status: 'login-form-unavailable' }; }
          formUnavailable.delete(channel.id);
          let credentials;
          try { credentials = autoLogin.claim(channel.id); }
          catch { autoLoginSuspended.add(channel.id); return { status: 'login-required' }; }
          if (!credentials) return { status: 'login-required' };
          autoLoginBusy.add(channel.id);
          const generation = loginGeneration.get(channel.id) || 0;
          let submitted = false;
          let unavailableForm = false;
          let phase = 'inject';
          let settled = null, settledSamples = 0, settledSnapshot = null;
          try {
            if (!window.isVisible() && generation === (loginGeneration.get(channel.id) || 0)) {
              phase = 'injecting';
              submitted = await window.webContents.executeJavaScript(channelLoginScript(channel, credentials), true) === true;
            }
            unavailableForm = !submitted;
            if (unavailableForm) formUnavailable.add(channel.id);
            if (submitted) {
              phase = 'submitted';
              let signedIn = false;
              for (let i = 0; i < 12; i++) {
                if (generation !== (loginGeneration.get(channel.id) || 0) || window.isDestroyed() || window.isVisible()) break;
                const state = await window.webContents.executeJavaScript(`(() => ({
                  origin: location.origin, path: location.pathname,
                  appReady: !!document.querySelector('#app'),
                  dashboardNavVisible: [...document.querySelectorAll('nav a[href]')].some(node => {
                    if (!node.getClientRects().length) return false;
                    try { const url = new URL(node.href, location.href);
                      return url.origin === ${JSON.stringify(channel.origin)} && url.pathname === '/dashboard'; }
                    catch { return false; }
                  }),
                  loginVisible: !!(document.querySelector(${JSON.stringify(LOGIN_FORMS[channel.id].passwordSelector)})?.getClientRects().length)
                }))()`, true);
                if (state?.origin === channel.origin && !state.loginVisible &&
                    (channel.id === 'spent-aerorelay' ?
                      state.appReady === true && state.dashboardNavVisible === true && state.path !== '/login' :
                      state.path === '/admin/' || state.path === channel.path)) { signedIn = true; break; }
                await wait(1000);
              }
              if (!signedIn) throw new Error('login did not settle');
              if (channel.id === 'spent-aerorelay') {
                let atDashboard = false;
                for (let i = 0; i < 10 && !atDashboard; i++) {
                  if (window.isDestroyed() || window.isVisible() || generation !== (loginGeneration.get(channel.id) || 0)) break;
                  const url = window.webContents.getURL();
                  try { atDashboard = allowed(channel, url) && new URL(url).pathname === channel.path; } catch { /* Wait for redirect. */ }
                  if (!atDashboard) {
                    try { atDashboard = await window.webContents.executeJavaScript(aeroDashboardNavigationScript(channel), true) === true; }
                    catch { /* Wait for the app to mount. */ }
                  }
                  if (!atDashboard) await wait(500);
                }
                if (!atDashboard) throw new Error('dashboard navigation unavailable');
              } else await window.loadURL(channel.origin + channel.path);
              for (let i = 0; i < 7; i++) {
                if (window.isDestroyed() || window.isVisible() || generation !== (loginGeneration.get(channel.id) || 0)) break;
                const after = await window.webContents.executeJavaScript(observationScript(channel), true);
                if (after?.origin === channel.origin && after.path === channel.path && !after.login &&
                    (after.balanceCandidates?.length || after.labeledCandidates?.length)) {
                  const snapshot = JSON.stringify([after.balanceCandidates, after.labeledCandidates]);
                  settledSamples = snapshot === settledSnapshot ? settledSamples + 1 : 1;
                  settledSnapshot = snapshot; settled = after;
                  if (settledSamples >= 2) break;
                } else { settledSamples = 0; settledSnapshot = null; }
                await wait(1000);
              }
            }
          } catch { /* No raw page or credential errors enter logs. */ }
          if (generation !== (loginGeneration.get(channel.id) || 0) || window.isDestroyed() || window.isVisible()) {
            autoLoginBusy.delete(channel.id);
            return { status: 'login-required' };
          }
          const verified = settled && settledSamples >= 2;
          if (!verified && !window.isVisible() && unavailableForm) {
            try { autoLogin.resume(channel.id, credentials); } catch { autoLoginSuspended.add(channel.id); }
          }
          if (!verified && !window.isVisible() && !unavailableForm && phase !== 'inject') autoLoginSuspended.add(channel.id);
          autoLoginBusy.delete(channel.id);
          if (verified) {
            try { autoLogin.resume(channel.id, credentials); } catch { autoLoginSuspended.add(channel.id); }
            return settled;
          }
          if (formUnavailable.has(channel.id)) return { status: 'login-form-unavailable' };
          return { status: 'login-required' };
        }
        previous = null;
        await wait(1000);
        continue;
      }
      loginSamples = 0;
      if (result.balanceCandidates?.length || result.labeledCandidates?.length) {
        const snapshot = JSON.stringify([result.balanceCandidates, result.labeledCandidates]);
        if (previous === snapshot) {
          formUnavailable.delete(channel.id);
          return result;
        }
        previous = snapshot;
      } else previous = null;
      await wait(1000);
    }
    return { origin: channel.origin, path: channel.path, balanceCandidates: [], labeledCandidates: [] };
  }
  function closeAll() {
    for (const window of windows.values()) { if (!window.isDestroyed()) window.destroy(); }
    windows.clear();
  }
  function cancelAutoLogin(id) {
    if (!LOGIN_FORMS[id]) return;
    loginGeneration.set(id, (loginGeneration.get(id) || 0) + 1);
    formUnavailable.delete(id); autoLoginSuspended.delete(id);
  }
  return { load, observe, closeAll, cancelAutoLogin, windows };
}
module.exports = { createChannelHost, allowed, channelLoginScript, aeroLoginScript,
  aeroDashboardNavigationScript, aeroPublicLoginRouteScript, LOGIN_FORMS };

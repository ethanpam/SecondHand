'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const fixedText = (value, length = 360) => typeof value === 'string' ? value.slice(0, length) : '';
  const trusted = callback => event => { if (event.isTrusted) return callback(event); };
  const send = async payload => {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.ok) throw new Error(fixedText(response?.error) || 'The assistant is unavailable. Reload the extension and this Iowa page.');
    return response.data;
  };

  if (location.search === '?surface=launcher' && !location.hash) {
    document.body.classList.add('launcher-surface');
    $('launcher').hidden = false;
    $('open-side-panel').addEventListener('click', trusted(async () => {
      $('open-side-panel').disabled = true;
      try {
        // Send immediately inside the trusted click; do not await tab lookup.
        await send({ type: 'ui:openPanel', confirmed: true });
        $('launcher-caption').textContent = 'Your checklist is in Chrome’s sidebar';
        $('launcher-status').textContent = 'Assistant opened in Chrome’s sidebar.';
      } catch (error) {
        $('launcher-caption').textContent = 'Try SecondHand’s toolbar icon';
        $('launcher-status').textContent = error.message;
        $('open-side-panel').title = error.message;
      } finally { $('open-side-panel').disabled = false; }
    }));
    return;
  }
  if (location.search || location.hash) return;
  $('sidepanel').hidden = false;

  let snapshot = null;
  let preview = null;
  let target = null;
  let contextRevision = 0;
  let fieldSignature = '';
  let checklistSignature = '';
  let currentPageKey = '';
  let working = false;
  let activeAction = '';
  let actionSerial = 0;
  let pollPromise = null;
  let pollTimer;
  let refreshAgain = false;
  let stopped = false;
  let automatic = { enabled: false, paused: false, reason: '' };
  const chosen = () => Array.from(document.querySelectorAll('#fields input:checked'), input => input.value);
  const busy = () => working || Boolean(snapshot?.busy);
  const show = (text, error = false) => {
    const next = fixedText(text, 650);
    if ($('status').textContent !== next) $('status').textContent = next;
    $('status').classList.toggle('error', error);
  };
  function supportedUrl(raw) {
    try {
      const url = new URL(raw);
      return url.origin === 'https://hhsservices.iowa.gov' && !url.username && !url.password && !url.port &&
        (url.pathname === '/apspssp/ssp.portal' || url.pathname.startsWith('/apspssp/ssp.portal/')) && !/%|\\/.test(url.pathname);
    } catch { return false; }
  }
  function clearPage() {
    snapshot = null; preview = null;
    fieldSignature = ''; checklistSignature = ''; currentPageKey = '';
    automatic = { enabled: false, paused: false, reason: '' };
    $('fields').replaceChildren(); $('page-checklist').replaceChildren();
    $('checklist-section').hidden = true; $('field-preview').hidden = true;
    $('manual-note').hidden = true; $('manual-reason').textContent = '';
    $('confirm').checked = false;
  }
  function invalidateTarget() {
    contextRevision++; actionSerial++;
    working = false; activeAction = ''; target = null;
    clearPage(); controls();
    $('site-label').textContent = 'CHECKING ACTIVE TAB';
    show('Checking the application in your active tab…');
  }
  function controls() {
    const filling = Boolean(target && preview?.recognizedPage && chosen().length && $('confirm').checked && !busy() && !automatic.enabled);
    $('fill-page').disabled = !filling;
    $('fill-next').disabled = !filling;
    $('refresh').disabled = busy();
    $('check-desktop').disabled = working || !target;
    document.querySelectorAll('#fields input').forEach(input => { input.disabled = busy() || automatic.enabled; });
    document.querySelectorAll('.checklist-item').forEach(button => { button.disabled = busy() || !target; });
    $('confirm').disabled = busy() || automatic.enabled;
    const waiting = Boolean(automatic.waitingForInfo);
    const running = automatic.enabled && !automatic.paused && !waiting;
    $('start-auto').hidden = running || activeAction === 'start';
    $('pause-auto').hidden = !automatic.enabled && activeAction !== 'start';
    $('pause-auto').disabled = activeAction === 'pause';
    $('pause-auto').textContent = automatic.paused || waiting ? 'Stop guided session' : 'Pause automatic mode';
    $('start-auto').disabled = busy() || !preview?.recognizedPage || !target;
    $('start-auto').textContent = waiting ? 'Check and continue →' : automatic.paused ? 'Resume guided autofill →' : 'Start guided autofill →';
    $('guided-state').textContent = waiting ? 'WAITING FOR MISSING INFORMATION' : running ? 'GUIDED AUTOFILL IS ACTIVE' : automatic.paused ? 'PAUSED FOR YOUR REVIEW' : 'YOU CHOOSE WHEN TO START';
    const reason = waiting ? `${fixedText(automatic.reason)} Add the missing required answers in Iowa’s form. Guided mode will check again automatically.` : fixedText(automatic.reason);
    $('automatic-reason').hidden = !reason;
    $('automatic-reason').textContent = reason;
    $('header-state').textContent = waiting ? 'WAITING FOR REQUIRED ANSWERS' : running ? 'GUIDED AUTOFILL ACTIVE' : automatic.paused ? 'WAITING FOR YOUR NEXT STEP' : 'IOWA SNAP ASSISTANT';
  }
  function renderFields(scan, pageKey) {
    const fields = Array.isArray(scan?.fields) ? scan.fields.filter(field => field && typeof field.key === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(field.key) && typeof field.label === 'string').slice(0, 50) : [];
    const signature = `${pageKey}|${JSON.stringify(fields.map(field => [field.key, field.label]))}`;
    if (signature !== fieldSignature) {
      const selected = pageKey === currentPageKey ? new Map(Array.from(document.querySelectorAll('#fields input'), input => [input.value, input.checked])) : new Map();
      $('fields').replaceChildren();
      for (const field of fields) {
        const label = document.createElement('label'); label.className = 'field';
        const input = document.createElement('input'); input.type = 'checkbox'; input.value = field.key;
        input.checked = selected.has(field.key) ? selected.get(field.key) : true;
        input.addEventListener('change', controls);
        const caption = document.createElement('span'); caption.textContent = fixedText(field.label, 90);
        label.append(input, caption); $('fields').append(label);
      }
      fieldSignature = signature; $('confirm').checked = false;
    }
    currentPageKey = pageKey;
    $('field-count').textContent = String(fields.length);
    $('field-preview').hidden = !scan?.recognizedPage || !fields.length;
  }
  function renderChecklist(page, missingProfileFields) {
    const allowed = new Set(['complete', 'missing', 'optional', 'manual']);
    const entries = Array.isArray(page.checklist) ? page.checklist.filter(item => item && typeof item.key === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(item.key) && typeof item.label === 'string' && allowed.has(item.status)).slice(0, 80) : [];
    const absent = new Set(Array.isArray(missingProfileFields) ? missingProfileFields : []);
    const signature = JSON.stringify([entries, [...absent]]);
    if (signature === checklistSignature) return;
    checklistSignature = signature;
    $('page-checklist').replaceChildren();
    for (const item of entries) {
      const button = document.createElement('button'); button.type = 'button'; button.className = `checklist-item ${item.status}`;
      button.dataset.key = item.key;
      const mark = document.createElement('span'); mark.className = 'checklist-mark'; mark.setAttribute('aria-hidden', 'true');
      mark.textContent = item.status === 'complete' ? '✓' : item.status === 'manual' ? '!' : '○';
      const copy = document.createElement('span'); copy.className = 'checklist-copy';
      const label = document.createElement('span'); label.className = 'checklist-label'; label.textContent = fixedText(item.label, 100);
      const detail = document.createElement('span'); detail.className = 'checklist-detail';
      const statusText = item.status === 'complete' ? 'Complete' : item.status === 'manual' ? 'Needs manual review' : absent.has(item.key) ? (item.required ? 'Missing from saved profile' : 'Not in saved profile · optional') : item.status === 'optional' ? 'Optional · blank' : item.required ? 'Missing required' : 'Missing answer';
      detail.textContent = `${statusText}${item.fillable && item.status !== 'complete' ? ' · Supported for autofill' : ''}`;
      copy.append(label, detail);
      const jump = document.createElement('span'); jump.className = 'checklist-jump'; jump.textContent = '↗'; jump.setAttribute('aria-hidden', 'true');
      button.setAttribute('aria-label', `${fixedText(item.label, 100)}: ${statusText}. Find in Iowa’s form.`);
      button.append(mark, copy, jump);
      button.addEventListener('click', trusted(() => { if (!button.disabled) action('focus', { type: 'ui:focusField', key: item.key }, `Finding ${fixedText(item.label, 100)} in Iowa’s form…`); }));
      $('page-checklist').append(button);
    }
    const complete = entries.filter(item => item.status === 'complete').length;
    const missing = entries.filter(item => item.required && item.status !== 'complete').length;
    $('checklist-summary').textContent = `${complete}/${entries.length} complete${missing ? ` · ${missing} required` : ''}`;
    $('checklist-section').hidden = !entries.length;
  }
  function render(result) {
    if (!result || typeof result !== 'object') throw new Error('The page state could not be read. Rescan the page.');
    snapshot = result; preview = result.scan || null;
    automatic = result.automatic && typeof result.automatic === 'object' ? result.automatic : automatic;
    const page = result.page || {};
    renderFields(preview, `${target?.id}|${target?.url}|${fixedText(page.pageKey, 120)}`);
    renderChecklist(page, result.missingProfileFields);
    const manual = ['manual', 'blocked', 'unsupported'].includes(page.kind) || Number(page.manualRemaining) > 0;
    $('manual-note').hidden = !manual;
    $('manual-reason').textContent = manual ? fixedText(page.reason) || 'Complete this step yourself. It is not verified for automatic filling or navigation.' : '';
    if (result.busy) show('Working with SecondHand. Review any approval request in the desktop app.');
    else if (result.lastResult?.message) show(result.lastResult.message, Boolean(result.lastResult.error));
    else if (manual) show('Some answers need your input. Use the checklist to find what is missing.');
    else if (preview?.fields?.length) show(`${preview.fields.length} supported field(s) can be requested from your local profile. Approval happens in SecondHand.`);
    else show('Review your checklist and the answers in Iowa’s form before continuing.');
    controls();
  }
  async function refresh() {
    if (stopped) return;
    if (pollPromise) { refreshAgain = true; return pollPromise; }
    let revision = contextRevision;
    pollPromise = (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (revision !== contextRevision || stopped) return;
        if (!tab || !Number.isInteger(tab.id) || !supportedUrl(tab.url)) {
          target = null; clearPage(); controls();
          $('site-label').textContent = 'WAITING FOR IOWA';
          show('Open Iowa’s SNAP application in your active tab. Your checklist will appear here automatically.');
          return;
        }
        if (!target || target.id !== tab.id || target.url !== tab.url) {
          contextRevision++; revision = contextRevision;
          clearPage(); target = { id: tab.id, url: tab.url };
        }
        $('site-label').textContent = 'OFFICIAL IOWA PORTAL';
        const result = await send({ type: 'ui:pageState', tabId: tab.id });
        if (revision === contextRevision && !stopped) render(result);
      } catch (error) {
        if (revision === contextRevision) {
          const lastAutomatic = automatic; clearPage(); automatic = lastAutomatic;
          controls(); show(error.message, true);
        }
      } finally {
        pollPromise = null;
        if (refreshAgain && !stopped) { refreshAgain = false; queueMicrotask(refresh); }
      }
    })();
    return pollPromise;
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (stopped) return;
    pollTimer = setTimeout(async () => {
      if (!working && !document.hidden) await refresh();
      schedulePoll();
    }, 1500);
  }
  async function action(kind, payload, waitingMessage) {
    if (!target) return;
    const selected = { ...target };
    const revision = contextRevision;
    const serial = ++actionSerial;
    working = true; activeAction = kind; controls();
    try {
      if (pollPromise) await pollPromise;
      if (serial !== actionSerial || revision !== contextRevision) return;
      show(waitingMessage);
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (serial !== actionSerial || revision !== contextRevision) return;
      if (active?.id !== selected.id || active.url !== selected.url) {
        invalidateTarget(); await refresh(); return;
      }
      const result = await send({ ...payload, tabId: selected.id });
      if (serial !== actionSerial || revision !== contextRevision) return;
      if (kind === 'desktop') {
        const connected = result?.connected !== false;
        $('desktop-status').textContent = !connected ? 'Open SecondHand and prepare its Chrome extension.' : result?.unlocked ? 'Vault unlocked. Ready for your approval.' : 'Open SecondHand and unlock your vault.';
        $('desktop-status').parentElement.classList.toggle('error', !connected || !result?.unlocked);
      }
      if (result?.message) show(result.message, Boolean(result.error));
      if (kind === 'focus' && !result?.focused) show('That detail is not safely available to focus. Find it directly in Iowa’s form.');
      if (kind === 'fill' || kind === 'next') $('confirm').checked = false;
      await refresh();
    } catch (error) {
      if (serial === actionSerial && revision === contextRevision) {
        show(error.message, true);
        if (kind === 'desktop') { $('desktop-status').textContent = 'Open SecondHand, prepare the extension, and unlock your vault.'; $('desktop-status').parentElement.classList.add('error'); }
      }
    } finally {
      if (serial === actionSerial) { working = false; activeAction = ''; controls(); schedulePoll(); }
    }
  }

  $('confirm').addEventListener('change', controls);
  $('refresh').addEventListener('click', trusted(() => { if (!busy()) refresh(); }));
  $('check-desktop').addEventListener('click', trusted(() => action('desktop', { type: 'ui:desktopStatus' }, 'Checking your local desktop connection…')));
  for (const [id, kind, type] of [['fill-page', 'fill', 'ui:fill'], ['fill-next', 'next', 'ui:fillAndNext']]) {
    $(id).addEventListener('click', trusted(() => {
      if ($(id).disabled || !$('confirm').checked || !preview?.token || !chosen().length) return;
      action(kind, { type, token: preview.token, fields: chosen(), confirmed: true }, 'Approve the selected fields in SecondHand. Your checklist will stay here.');
    }));
  }
  $('start-auto').addEventListener('click', trusted(() => {
    if (!$('start-auto').disabled) action('start', { type: 'ui:auto', enabled: true, confirmed: true }, 'Review the guided autofill scope in SecondHand. It will wait for any missing required answers.');
  }));
  $('pause-auto').addEventListener('click', trusted(() => {
    if (!$('pause-auto').disabled) action('pause', { type: 'ui:auto', enabled: false, confirmed: true }, 'Stopping automatic mode…');
  }));
  chrome.tabs.onActivated?.addListener(() => { invalidateTarget(); refresh(); });
  chrome.tabs.onUpdated?.addListener((tabId, change) => {
    if (target?.id === tabId && (change.url || change.status === 'loading')) { invalidateTarget(); refresh(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !working) refresh(); });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(pollTimer); actionSerial++; preview = null; snapshot = null; }, { once: true });
  refresh(); schedulePoll();
})();

'use strict';

(() => {
  const $ = id => document.getElementById(id);
  let snapshot = null;
  let preview = null;
  let fieldSignature = '';
  let currentPageKey = '';
  let collapsed = false;
  let working = false;
  let activeAction = '';
  let actionSerial = 0;
  let pollPromise = null;
  let pollTimer;
  let automatic = { enabled: false, paused: false, reason: '' };

  const fixedText = (value, length = 360) => typeof value === 'string' ? value.slice(0, length) : '';
  const chosen = () => Array.from(document.querySelectorAll('#fields input:checked'), input => input.value);
  const busy = () => working || Boolean(snapshot?.busy);
  const message = async payload => {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.ok) throw new Error(fixedText(response?.error) || 'The assistant is unavailable. Reload the extension and this Iowa page.');
    return response.data;
  };
  const show = (text, error = false) => {
    const next = fixedText(text, 650);
    if ($('status').textContent !== next) $('status').textContent = next;
    $('status').classList.toggle('error', error);
  };
  const trusted = callback => event => { if (event.isTrusted) callback(event); };

  function controls() {
    const filling = Boolean(preview?.recognizedPage && chosen().length && $('confirm').checked && !busy() && !automatic.enabled);
    $('fill-page').disabled = !filling;
    $('fill-next').disabled = !filling;
    $('refresh').disabled = busy();
    $('check-desktop').disabled = working;
    document.querySelectorAll('#fields input').forEach(input => { input.disabled = busy() || automatic.enabled; });
    $('confirm').disabled = busy() || automatic.enabled;
    const running = automatic.enabled && !automatic.paused;
    $('start-auto').hidden = running || activeAction === 'start';
    $('pause-auto').hidden = !automatic.enabled && activeAction !== 'start';
    $('pause-auto').disabled = activeAction === 'pause';
    $('pause-auto').textContent = automatic.paused ? 'Stop guided session' : 'Pause automatic mode';
    $('start-auto').disabled = busy() || !preview?.recognizedPage;
    $('start-auto').textContent = automatic.paused ? 'Resume guided autofill →' : 'Start guided autofill →';
    $('guided-state').textContent = running ? 'GUIDED AUTOFILL IS ACTIVE' : automatic.paused ? 'PAUSED FOR YOUR REVIEW' : 'YOU CHOOSE WHEN TO START';
    $('automatic-reason').hidden = !automatic.reason;
    $('automatic-reason').textContent = fixedText(automatic.reason);
    $('header-state').textContent = running ? 'GUIDED AUTOFILL ACTIVE' : automatic.paused ? 'WAITING FOR YOUR NEXT STEP' : 'IOWA SNAP ASSISTANT';
  }

  function renderFields(scan, pageKey) {
    const fields = Array.isArray(scan?.fields) ? scan.fields.filter(field => field && typeof field.key === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(field.key) && typeof field.label === 'string').slice(0, 30) : [];
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
      fieldSignature = signature;
      $('confirm').checked = false;
    }
    currentPageKey = pageKey;
    $('field-count').textContent = String(fields.length);
    $('field-preview').hidden = !scan?.recognizedPage || !fields.length;
  }

  function render(result) {
    if (!result || typeof result !== 'object') throw new Error('The page state could not be read. Rescan the page.');
    snapshot = result;
    preview = result.scan || null;
    automatic = result.automatic && typeof result.automatic === 'object' ? result.automatic : automatic;
    const page = result.page || {};
    renderFields(preview, fixedText(page.pageKey, 120));
    const manual = ['manual', 'blocked', 'unsupported'].includes(page.kind) || Number(page.manualRemaining) > 0;
    $('manual-note').hidden = !manual;
    $('manual-reason').textContent = manual ? fixedText(page.reason) || 'Complete this page yourself. This step is not verified for automatic filling or navigation.' : '';
    if (result.busy) show('Working with SecondHand. If a desktop approval appears, review the request there.');
    else if (result.lastResult?.message) show(result.lastResult.message, Boolean(result.lastResult.error));
    else if (manual) show('This step needs your review. Nothing will be submitted automatically.');
    else if (preview?.fields?.length) show(`${preview.fields.length} supported field(s) found. Only field names are shown here; your profile stays in the desktop vault until you approve.`);
    else show('No empty supported fields are visible. Review the form, or scroll and rescan.');
    controls();
  }

  async function refresh() {
    if (pollPromise) return pollPromise;
    pollPromise = (async () => {
      try { render(await message({ type: 'ui:pageState' })); }
      catch (error) { show(error.message, true); }
      finally { pollPromise = null; }
    })();
    return pollPromise;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (!working && !document.hidden) await refresh();
      schedulePoll();
    }, 2000);
  }

  async function action(kind, payload, waitingMessage) {
    const serial = ++actionSerial;
    working = true; activeAction = kind;
    controls();
    // Finish any metadata scan before sending the approved action's current token.
    if (pollPromise) await pollPromise;
    if (serial !== actionSerial) return;
    show(waitingMessage);
    try {
      const actualPayload = typeof payload === 'function' ? payload() : payload;
      const result = await message(actualPayload);
      if (serial !== actionSerial) return;
      if (kind === 'desktop') {
        const connected = result?.connected !== false;
        $('desktop-status').textContent = !connected ? 'Open SecondHand and prepare its Chrome extension.' : result?.unlocked ? 'Vault unlocked. Ready for your approval.' : 'Open SecondHand and unlock your vault.';
        $('desktop-status').parentElement.classList.toggle('error', !connected || !result?.unlocked);
      }
      if (result?.message) show(result.message, Boolean(result.error));
      if (kind === 'fill' || kind === 'next') $('confirm').checked = false;
      await refresh();
    } catch (error) {
      if (serial === actionSerial) {
        show(error.message, true);
        if (kind === 'desktop') {
          $('desktop-status').textContent = 'Open SecondHand, prepare the extension, and unlock your vault.';
          $('desktop-status').parentElement.classList.add('error');
        }
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
      action(kind, { type, token: preview.token, fields: chosen(), confirmed: true }, 'Approve the selected fields in SecondHand. The desktop window may come forward; this helper will stay here.');
    }));
  }
  $('start-auto').addEventListener('click', trusted(() => {
    if ($('start-auto').disabled) return;
    action('start', { type: 'ui:auto', enabled: true, confirmed: true }, 'Review the guided autofill scope in SecondHand. It will stop for steps that need your input.');
  }));
  $('pause-auto').addEventListener('click', trusted(() => {
    if ($('pause-auto').disabled) return;
    action('pause', { type: 'ui:auto', enabled: false, confirmed: true }, 'Pausing automatic mode…');
  }));
  $('collapse').addEventListener('click', trusted(async () => {
    const next = !collapsed;
    try {
      await message({ type: 'ui:panel', collapsed: next });
      collapsed = next;
      document.body.classList.toggle('collapsed', collapsed);
      $('panel-body').hidden = collapsed;
      $('collapse').textContent = collapsed ? '+' : '−';
      $('collapse').setAttribute('aria-label', collapsed ? 'Expand assistant' : 'Collapse assistant');
      $('collapse').setAttribute('aria-expanded', String(!collapsed));
    } catch (error) { show(error.message, true); }
  }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !working) refresh(); });
  window.addEventListener('pagehide', () => { clearTimeout(pollTimer); actionSerial++; preview = null; snapshot = null; }, { once: true });
  refresh();
  schedulePoll();
})();

'use strict';
const $ = id => document.getElementById(id);
let preview = null;
let selectedTab = null;
const show = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
const message = async payload => {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) throw new Error(response?.error || 'The companion is unavailable. Reopen it and try again.');
  return response.data;
};
const chosen = () => Array.from(document.querySelectorAll('#fields input:checked'), input => input.value);
const enableFill = () => { $('fill').disabled = !preview || !$('confirm').checked || !chosen().length; $('fill-next').disabled = $('fill').disabled; };
$('confirm').addEventListener('change', enableFill);
$('scan').addEventListener('click', async () => {
  $('scan').disabled = true;
  $('preview').hidden = true;
  preview = null;
  $('confirm').checked = false;
  show('Looking for supported fields on the current page…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !SecondHandIowa.isSupportedUrl(tab.url)) throw new Error('Open Iowa’s official benefits portal in the active tab. This extension works only there.');
    selectedTab = tab.id;
    preview = await message({ type: 'ui:scan', tabId: tab.id });
    $('fields').replaceChildren();
    if (!preview.recognizedPage) { show('This page is not supported for filling. Navigate yourself to Enter Personal Information, then scan again. Program choices, CAPTCHA, login, other household members, signatures, and submission stay manual.'); return; }
    if (!preview.fields.length) { show('No empty supported fields matched safely. Review the form or use the on-page assistant to continue.'); return; }
    for (const field of preview.fields) {
      const label = document.createElement('label'); label.className = 'field';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = field.key; input.checked = true; input.addEventListener('change', enableFill);
      const text = document.createElement('span'); text.textContent = field.label;
      label.append(input, text); $('fields').append(label);
    }
    $('preview').hidden = false;
    const ambiguity = preview.ambiguous.length ? ` ${preview.ambiguous.length} ambiguous field(s) were skipped.` : '';
    show(`${preview.fields.length} field(s) matched. No profile data has been requested.${ambiguity}`);
    enableFill();
  } catch (error) { show(error.message, true); }
  finally { $('scan').disabled = false; }
});
async function fillSelected(advance = false) {
  if (!preview || !$('confirm').checked || !chosen().length) return;
  $('fill').disabled = true; $('fill-next').disabled = true; $('scan').disabled = true;
  show('Approve the selected fields in the SecondHand desktop app. You can reopen this popup afterward to see the result.');
  try {
    const result = await message({ type: advance ? 'ui:fillAndNext' : 'ui:fill', tabId: selectedTab, token: preview.token, fields: chosen(), confirmed: true });
    show(result.message, Boolean(result.error));
  } catch (error) { show(error.message, true); }
  finally { preview = null; $('preview').hidden = true; $('scan').disabled = false; }
}
$('fill').addEventListener('click', () => fillSelected(false));
$('fill-next').addEventListener('click', () => fillSelected(true));
$('show-assistant').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !SecondHandIowa.isSupportedUrl(tab.url)) throw new Error('Open Iowa’s official application first.');
    await message({ type: 'ui:panel', tabId: tab.id, collapsed: false });
    window.close();
  } catch (error) { show(error.message, true); }
});
(async () => {
  $('extension-id').textContent = chrome.runtime.id;
  try {
    const status = await message({ type: 'ui:status' });
    if (status.lastResult) show(status.lastResult.message, Boolean(status.lastResult.error));
    if (status.busy) { $('scan').disabled = true; show('A fill request is waiting for approval in SecondHand. Finish it there, then reopen this popup.'); }
  } catch (error) { show(error.message, true); }
})();

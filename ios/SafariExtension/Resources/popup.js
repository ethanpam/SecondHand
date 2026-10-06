"use strict";
const node = id => document.getElementById(id);
let snapshot = null;
let busy = false;
let requestingPermission = false;
let requestGeneration = 0;
let actionIDs = {};
function render(response) {
  snapshot = response;
  const workflow = response?.workflow;
  const scan = response?.scan;
  node("status").textContent = response?.message || "Unable to check the session. Try again.";
  const site = response?.site;
  node("site-controls").hidden = !site || site.iowa;
  node("site-origin").textContent = site ? `${site.origin} · ${site.approved ? "Approved" : "Not approved"}` : "";
  node("site-sensitive").checked = site?.includeSensitive === true;
  node("site-sensitive-row").hidden = site?.approved === true;
  node("allow-site").hidden = site?.approved === true;
  node("remove-site").hidden = !site?.approved;
  node("forget-mappings").hidden = !site?.approved;
  node("start").hidden = !!workflow || !site?.approved;
  node("setup").hidden = !!workflow;
  node("session").hidden = !workflow;
  node("page").hidden = !scan;
  node("reviewed").checked = false;
  node("confirmed").checked = false;
  node("submit").disabled = true;
  node("save-receipt").disabled = true;
  node("confirmation").value = "";
  node("fields").replaceChildren();
  node("remember").checked = false;
  node("remember-row").hidden = true;
  actionIDs = {};
  if (!workflow) return;
  const remaining = Math.max(0, Math.ceil((workflow.expiresAt - Date.now()) / 60000));
  node("progress").textContent = `${remaining} min remaining · ${workflow.filled} fields filled`;
  node("resume").hidden = !["paused", "suspended"].includes(workflow.phase);
  node("pause").hidden = ["paused", "suspended", "awaiting_confirmation", "receipt"].includes(workflow.phase);
  if (!scan) return;
  node("page-title").textContent = scan.title;
  const pendingSubmission = workflow.phase === "awaiting_confirmation";
  const suspended = workflow.phase === "suspended";
  const mappable = !pendingSubmission && !suspended && ["known", "mapping"].includes(scan.kind);
  for (const field of (mappable ? scan.fields : [])) {
    const label = document.createElement("label");
    label.className = "field";
    const caption = document.createElement("span");
    caption.textContent = field.label + (field.remembered ? " · Remembered match" : field.suggestedKey ? " · Suggested match" : "");
    const select = document.createElement("select");
    select.dataset.fieldId = field.id;
    const skip = document.createElement("option");
    skip.value = ""; skip.textContent = "Leave this field for me"; select.append(skip);
    for (const [key, title] of Object.entries(response.savedFields)) {
      if (field.key && key !== field.key) continue;
      if (field.allowedKeys && !field.allowedKeys.includes(key)) continue;
      const option = document.createElement("option");
      option.value = key; option.textContent = title;
      option.selected = (field.key || field.suggestedKey) === key;
      select.append(option);
    }
    label.append(caption, select); node("fields").append(label);
  }
  node("fill").hidden = !mappable || !scan.fields.length;
  node("remember-row").hidden = node("fill").hidden;
  node("counts").textContent = `${scan.populated || 0} already filled · ${scan.ambiguous || 0} unclear fields left for you`;
  const next = scan.actions.find(action => action.kind === "continue");
  const submit = scan.actions.find(action => action.kind === "submit");
  actionIDs = { continue: next?.id, submit: submit?.id, nextReady: next?.ready === true };
  node("continue").hidden = !next || pendingSubmission || suspended || scan.kind === "signature" || scan.kind === "receipt";
  node("continue").disabled = !actionIDs.nextReady;
  node("signature").hidden = scan.kind !== "signature" || !submit || pendingSubmission || suspended;
  node("receipt").hidden = scan.kind !== "receipt" || suspended;
}
function updateButtons() {
  for (const button of document.querySelectorAll("button")) {
    button.disabled = busy && !["stop", "pause"].includes(button.id);
  }
  node("continue").disabled = busy || !actionIDs.nextReady;
  node("submit").disabled = busy || !node("reviewed").checked;
  node("save-receipt").disabled = busy || !node("confirmed").checked || !node("confirmation").value.trim();
}
async function send(input) {
  const priority = ["stop", "pause"].includes(input.command);
  if (busy && !priority) return;
  const version = ++requestGeneration;
  node("reviewed").checked = false;
  node("confirmed").checked = false;
  busy = true;
  if (input.command === "start") {
    // Keep Stop available while the first native request or scrolling fill is running.
    node("session").hidden = false;
    node("progress").textContent = "Starting assistance…";
    node("pause").hidden = true;
    node("resume").hidden = true;
  }
  updateButtons();
  node("status").textContent = priority ? "Stopping the current action…" : "Checking the application…";
  try {
    const response = await browser.runtime.sendMessage(input);
    if (version !== requestGeneration) return;
    if (!response) throw new Error("unavailable");
    render(response);
  } catch {
    if (version === requestGeneration) {
      snapshot = null;
      actionIDs = {};
      node("page").hidden = true;
      node("status").textContent = "Unable to reach the assistant. Close and reopen this extension, then check the page again.";
    }
  } finally {
    if (version === requestGeneration) { busy = false; updateButtons(); }
  }
}
node("start").addEventListener("click", async () => {
  if (busy || requestingPermission) return;
  requestingPermission = true;
  node("start").disabled = true;
  // Host access is requested only from this explicit user gesture.
  try {
    const origin = snapshot?.site?.origin;
    if (!origin || !snapshot.site.approved) return;
    const granted = await browser.permissions.request({ origins: [origin + "/*"] });
    if (!granted) { node("status").textContent = "Allow access to this website to start assistance."; return; }
    await send({ command: "start" });
  } catch { node("status").textContent = "Allow this extension on this website in Safari, then try Start again."; }
  finally { requestingPermission = false; node("start").disabled = busy; }
});
for (const [id, command] of [["refresh", "status"], ["pause", "pause"], ["resume", "resume"], ["stop", "stop"]]) {
  node(id).addEventListener("click", () => send({ command }));
}
node("fill").addEventListener("click", () => {
  const assignments = [...node("fields").querySelectorAll("select")].filter(select => select.value)
    .map(select => ({ id: select.dataset.fieldId, key: select.value }));
  send({ command: "fill", previewToken: snapshot?.scan?.previewToken, assignments, remember: node("remember").checked });
});
node("continue").addEventListener("click", () => send({ command: "act", previewToken: snapshot?.scan?.previewToken, actionID: actionIDs.continue }));
node("reviewed").addEventListener("change", () => { node("submit").disabled = busy || !node("reviewed").checked; });
node("submit").addEventListener("click", () => {
  if (node("reviewed").checked) send({ command: "act", previewToken: snapshot?.scan?.previewToken, actionID: actionIDs.submit, approved: true });
});
function receiptReady() { node("save-receipt").disabled = busy || !node("confirmed").checked || !node("confirmation").value.trim(); }
node("confirmed").addEventListener("change", receiptReady);
node("confirmation").addEventListener("input", receiptReady);
node("save-receipt").addEventListener("click", () => {
  if (node("confirmed").checked) send({ command: "receipt", previewToken: snapshot?.scan?.previewToken, confirmed: true, confirmationNumber: node("confirmation").value });
});
node("allow-site").addEventListener("click", async () => {
  if (busy || requestingPermission || !snapshot?.site) return;
  const {origin} = snapshot.site;
  const includeSensitive = node("site-sensitive").checked;
  requestingPermission = true;
  try {
    if (await browser.permissions.request({origins: [origin + "/*"]})) await send({command: "approve-site", origin, includeSensitive});
    else node("status").textContent = "Website access was not approved.";
  } catch { node("status").textContent = "Allow this website in Safari’s extension settings, then try again."; }
  finally { requestingPermission = false; }
});
node("remove-site").addEventListener("click", () => send({command: "remove-site", origin: snapshot?.site?.origin}));
node("forget-mappings").addEventListener("click", () => send({command: "forget-mappings", origin: snapshot?.site?.origin}));
send({ command: "status" });

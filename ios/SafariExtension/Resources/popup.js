"use strict";
const previewButton = document.getElementById("preview");
const fillButton = document.getElementById("fill");
const statusNode = document.getElementById("status");
let preview = null;
let busy = false;

async function activePage() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !Number.isInteger(tab.id) || !SecondHandAutofill.isAllowedURL(tab.url)) {
    throw new Error("Open the Iowa Enter Personal Information application page in this tab first.");
  }
  return { tabId: tab.id, pageURL: tab.url };
}

function resultOf(results) {
  const top = results.find(result => result.frameId === 0);
  if (!top || top.error || !top.result || top.result.error) {
    if (top?.result?.error === "account_page") {
      throw new Error("Account pages stay manual. Sign in and open your application form, then preview again.");
    }
    if (top?.result?.error === "unrecognized_form") {
      throw new Error("This form does not match the inspected applicant page. Complete it manually.");
    }
    throw new Error("The page changed or the preview expired. Preview the fields again.");
  }
  return top.result;
}

previewButton.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  preview = null;
  previewButton.disabled = true;
  fillButton.disabled = true;
  document.getElementById("result").hidden = true;
  statusNode.textContent = "Checking this page for clear, empty contact fields…";
  try {
    const page = await activePage();
    await browser.scripting.executeScript({ target: { tabId: page.tabId, frameIds: [0] }, files: ["field-mapper.js"] });
    const scan = resultOf(await browser.scripting.executeScript({
      target: { tabId: page.tabId, frameIds: [0] },
      func: pageURL => globalThis.SecondHandAutofill.scan(document, pageURL), args: [page.pageURL]
    }));
    preview = { ...page, ...scan };
    const list = document.getElementById("fields");
    list.replaceChildren();
    for (const field of scan.fields) {
      const item = document.createElement("li");
      item.textContent = field.label;
      list.append(item);
    }
    document.getElementById("result").hidden = false;
    document.getElementById("skipped").textContent = `${scan.populated} already filled · ${scan.ambiguous} ambiguous fields skipped`;
    fillButton.disabled = scan.fields.length === 0;
    statusNode.textContent = scan.fields.length
      ? `${scan.fields.length} supported fields. Fill uses only saved details available in your current session.`
      : "No supported empty fields found. You can complete this form manually.";
  } catch (error) {
    statusNode.textContent = error instanceof Error && (error.message.startsWith("Open the Iowa") || error.message.startsWith("Account pages") || error.message.startsWith("This form"))
      ? error.message : "Unable to inspect this page. Allow this extension on the Iowa portal, then try again.";
  } finally {
    busy = false;
    previewButton.disabled = false;
  }
});

fillButton.addEventListener("click", async () => {
  if (busy || !preview) return;
  busy = true;
  fillButton.disabled = true;
  previewButton.disabled = true;
  const plan = preview;
  preview = null;
  let response = null;
  try {
    const before = await activePage();
    if (before.tabId !== plan.tabId || before.pageURL !== plan.pageURL) throw new Error("changed");
    // No private information is requested by previewing or visiting a webpage.
    response = await browser.runtime.sendNativeMessage("com.ethanpam.secondhand", {
      action: "contactFields", pageURL: plan.pageURL, keys: plan.fields.map(field => field.key)
    });
    if (!response || response.error || !response.fields || typeof response.fields !== "object"
      || Array.isArray(response.fields) || !Number.isFinite(response.expiresAt)
      || response.expiresAt <= Date.now() || response.expiresAt > Date.now() + 601_000) {
      statusNode.textContent = "Unlock SecondHand and enable a new autofill session, then preview these fields again.";
      return;
    }
    const keys = new Set(plan.fields.map(field => field.key));
    const fields = Object.fromEntries(Object.entries(response.fields).filter(([key, value]) =>
      keys.has(key) && typeof value === "string" && value.trim() && value.length <= 500));
    const after = await activePage();
    if (after.tabId !== plan.tabId || after.pageURL !== plan.pageURL) throw new Error("changed");
    const result = resultOf(await browser.scripting.executeScript({
      target: { tabId: plan.tabId, frameIds: [0] },
      func: (pageURL, token, values, expiresAt) => globalThis.SecondHandAutofill.fill(document, pageURL, token, values, expiresAt),
      args: [plan.pageURL, plan.token, fields, response.expiresAt]
    }));
    statusNode.textContent = result.filled
      ? `Filled ${result.filled} contact fields. Review every answer on the website before you submit.`
      : "No fields were filled. They may have changed or your saved profile may be empty. Review and fill them manually.";
  } catch {
    statusNode.textContent = "Unable to fill this page. Unlock SecondHand, enable autofill, and preview the fields again.";
  } finally {
    response = null;
    busy = false;
    previewButton.disabled = false;
  }
});

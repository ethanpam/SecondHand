/* The background owns the session. Webpages never receive a message endpoint. */
(function (root) {
  "use strict";
  const STORAGE_KEY = "secondHandWorkflow";
  const MAPPING_KEY = "secondHandSiteMappings";
  const SENSITIVE = new Set(["ssn", "annualIncome", "annualIncomeYear", "monthlyIncome", "monthlyHousingCost"]);
  const engine = typeof module !== "undefined" ? require("./application-assistant.js") : root.SecondHandApplication;
  const NATIVE_APP = "com.ethanpam.secondhand";
  const SAVED_FIELDS = Object.freeze({
    firstName: "First name", middleName: "Middle name", lastName: "Last name",
    email: "Email", homePhone: "Home phone", mobilePhone: "Mobile phone",
    addressLine1: "Home address line 1", addressLine2: "Home address line 2",
    city: "Home city", state: "Home state", postalCode: "Home ZIP code",
    ssn: "My Social Security number", annualIncome: "Selected annual income (check type and year)", annualIncomeYear: "Selected annual income year",
    monthlyIncome: "Monthly income", monthlyHousingCost: "Monthly housing cost"
  });
  // The applicant's explicit saved answer to "Do you have a home address?". Never inferred.
  const HOME_ANSWERS = Object.freeze({ yes: "Yes", no: "No" });
  const HOME_LEFT = "“Do you have a home address?” was left for you to answer on Iowa’s website.";
  const PHASES = new Set(["running", "processing", "paused", "suspended", "mapping", "ready", "signature", "navigating", "awaiting_confirmation", "receipt"]);
  const MESSAGES = {
    running: "Ready to check the next application step.", processing: "Filling the supported fields…",
    paused: "Paused. Complete this step on the website, then check the page again.",
    suspended: "Paused. Resume assistance when you are ready to fill or continue.",
    mapping: "Choose which saved detail belongs in each field. Leave uncertain fields unselected.",
    ready: "Review the answers on the website. Continue only when this step is complete.",
    signature: "Review the entire application and complete Iowa’s signature yourself before approving submission.",
    navigating: "Continue was clicked. Waiting for the next page; this does not mean the application was submitted.",
    awaiting_confirmation: "Submission was attempted. Check Iowa’s website for its result. Never assume a click means approval or submission.",
    receipt: "If Iowa confirms submission, enter its confirmation number below to save your progress."
  };
  function createWorkflow(api, options = {}) {
    const now = options.now || Date.now;
    const uuid = options.uuid || (() => root.crypto.randomUUID());
    const portalURL = options.isPortalURL || (url => engine.isPortalURL(url));
    let state = null, plan = null, message = "Unlock SecondHand and enable a sharing session, then open a form in Safari.";
    let site = null;
    let chain = Promise.resolve(), generation = 0, timer = null;
    const canceled = () => Object.assign(new Error("canceled"), { code: "canceled" });
    const problem = code => Object.assign(new Error(code), { code });
    const validState = value => value && Number.isInteger(value.tabId) && value.tabId >= 0
      && Number.isFinite(value.expiresAt) && value.expiresAt > now() && value.expiresAt <= now() + 601000
      && PHASES.has(value.phase) && Number.isInteger(value.pages) && value.pages >= 0
      && Number.isInteger(value.filled) && value.filled >= 0;
    function metadata() {
      return state ? { tabId: state.tabId, expiresAt: state.expiresAt, phase: state.phase, pages: state.pages, filled: state.filled, ...(state.origin ? {origin: state.origin} : {}) } : null;
    }
    function view() {
      const scan = plan && state ? {
        previewToken: plan.token, kind: plan.kind, title: plan.title, fields: plan.fields, actions: plan.actions,
        populated: plan.populated, ambiguous: plan.ambiguous
      } : null;
      return { workflow: metadata(), scan, message: message || (state ? MESSAGES[state.phase] : "Session stopped."), savedFields: SAVED_FIELDS, site };
    }
    function scheduleExpiry() {
      if (timer) clearTimeout(timer);
      if (!state || options.disableTimer) return;
      timer = setTimeout(() => { dispatch({ command: "expire" }); }, Math.max(1, state.expiresAt - now()));
      timer.unref?.();
    }
    async function persist() {
      if (state) await api.storage.local.set({ [STORAGE_KEY]: metadata() });
      else await api.storage.local.remove(STORAGE_KEY);
      scheduleExpiry();
    }
    async function clear(text) {
      state = null; plan = null; message = text;
      await persist();
    }
    const initialized = (async () => {
      const stored = (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (validState(stored)) {
        state = { tabId: stored.tabId, expiresAt: stored.expiresAt, phase: stored.phase, pages: stored.pages, filled: stored.filled, ...(stored.origin ? {origin: stored.origin} : {}) };
        // A suspended worker cannot safely replay a half-finished action.
        if (["processing", "navigating"].includes(state.phase)) state.phase = "suspended";
        message = MESSAGES[state.phase];
        await persist();
      } else if (stored) await clear("The assistance session expired. Enable a new session in SecondHand.");
    })();
    function check(version) {
      if (version !== generation) throw canceled();
      if (state && state.expiresAt <= now()) throw problem("expired");
    }
    async function describeSite(version) {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      check(version);
      const origin = engine.siteOrigin(tab?.url);
      if (!tab || !origin || !engine.isWebsiteURL(tab.url)) { site = null; return null; }
      if (portalURL(tab.url)) { site = {origin, approved: true, iowa: true}; return {tab, ...site}; }
      const response = await api.runtime.sendNativeMessage(NATIVE_APP, {action: "siteStatus", pageURL: tab.url});
      check(version);
      if (!response || response.error || response.origin !== origin) throw problem("site");
      site = {origin, approved: response.approved === true, includeSensitive: response.includeSensitive === true, iowa: false};
      return {tab, ...site};
    }
    async function mappingHash(identity) {
      const bytes = await root.crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
      return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
    }
    async function remembered(origin) {
      const all = (await api.storage.local.get(MAPPING_KEY))[MAPPING_KEY];
      if (!all || typeof all !== "object" || Array.isArray(all)) return {};
      const entries = all[origin];
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) return {};
      return Object.fromEntries(Object.entries(entries).slice(-100).filter(([hash, key]) => /^[a-f0-9]{64}$/.test(hash) && Object.hasOwn(SAVED_FIELDS, key)));
    }
    async function forgetMappings(origin) {
      const all = (await api.storage.local.get(MAPPING_KEY))[MAPPING_KEY] || {};
      const next = Object.fromEntries(Object.entries(all).filter(([key]) => key !== origin).slice(-50));
      if (Object.keys(next).length) await api.storage.local.set({[MAPPING_KEY]: next});
      else await api.storage.local.remove(MAPPING_KEY);
    }
    async function saveMappings(scan, selected, version) {
      const origin = engine.siteOrigin(scan.pageURL);
      const previous = await remembered(origin);
      for (const choice of selected) {
        const field = scan.fields.find(field => field.id === choice.id);
        if (field?.mappingHash && scan.fields.filter(item => item.mappingHash === field.mappingHash).length === 1) previous[field.mappingHash] = choice.key;
      }
      const stored = (await api.storage.local.get(MAPPING_KEY))[MAPPING_KEY] || {};
      check(version);
      const all = Object.fromEntries(Object.entries(stored).filter(([key]) => key !== origin).slice(-49));
      all[origin] = Object.fromEntries(Object.entries(previous).slice(-100));
      await api.storage.local.set({[MAPPING_KEY]: all});
    }
    async function page(version, expectedURL) {
      check(version);
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      check(version);
      if (!tab || !Number.isInteger(tab.id) || !engine.isWebsiteURL(tab.url)) throw problem("wrong_page");
      if (state && state.tabId !== tab.id) throw problem("wrong_tab");
      if (expectedURL && tab.url !== expectedURL) throw problem("changed");
      let approvedOrigin = null, includeSensitive = true, approvalRevision = null;
      if (!portalURL(tab.url)) {
        if (state && (state.origin || "https://hhsservices.iowa.gov") !== engine.siteOrigin(tab.url)) throw problem("site");
        // Browser permission and encrypted native approval are both required on every operation.
        const hasPermission = await api.permissions?.contains({origins: [engine.siteOrigin(tab.url) + "/*"]});
        check(version);
        if (hasPermission !== true) throw problem("site");
        const response = await api.runtime.sendNativeMessage(NATIVE_APP, {action: "siteStatus", pageURL: tab.url});
        check(version);
        if (response?.approved !== true || response.origin !== engine.siteOrigin(tab.url) || !/^[a-f0-9-]{36}$/i.test(response.revision || "")) throw problem("site");
        approvedOrigin = response.origin; approvalRevision = response.revision; includeSensitive = response.includeSensitive === true;
      } else if (state && (state.origin || "https://hhsservices.iowa.gov") !== engine.siteOrigin(tab.url)) throw problem("site");
      return { tabId: tab.id, pageURL: tab.url, approvedOrigin, includeSensitive, approvalRevision };
    }
    async function script(current, func, args) {
      const results = await api.scripting.executeScript({ target: { tabId: current.tabId, frameIds: [0] }, func, args });
      const result = results.find(item => item.frameId === 0);
      if (!result || result.error || !result.result || result.result.error) throw problem("changed");
      return result.result;
    }
    async function inspect(version) {
      const current = await page(version);
      await api.scripting.executeScript({ target: { tabId: current.tabId, frameIds: [0] }, files: ["iowa-adapter.js", "field-mapper.js", "application-assistant.js"] });
      check(version);
      await page(version, current.pageURL);
      const scan = await script(current, (url, origin) => globalThis.SecondHandApplication.inspect(document, url, origin), [current.pageURL, current.approvedOrigin]);
      check(version);
      await page(version, current.pageURL);
      if (!scan.token || scan.pageURL !== current.pageURL || !["known", "mapping", "manual", "signature", "receipt"].includes(scan.kind)
        || !Array.isArray(scan.fields) || !Array.isArray(scan.actions)) throw problem("changed");
      const mappings = await remembered(engine.siteOrigin(current.pageURL));
      for (const field of scan.fields) {
        if (current.approvedOrigin && !current.includeSensitive) field.allowedKeys = (field.allowedKeys || []).filter(key => !SENSITIVE.has(key));
        if (typeof field.mappingIdentity === "string" && field.mappingIdentity.length <= 20000) {
          field.mappingHash = await mappingHash(JSON.stringify([current.approvalRevision || "iowa", field.mappingIdentity]));
          const key = mappings[field.mappingHash];
          if (!field.key && field.allowedKeys?.includes(key)) { field.suggestedKey = key; field.remembered = true; }
        }
        delete field.mappingIdentity;
      }
      scan.fields = scan.fields.filter(field => !field.allowedKeys || field.allowedKeys.length);
      check(version);
      await page(version, current.pageURL);
      plan = { ...scan, ...current };
      return plan;
    }
    async function nativeFields(current, keys, version, use) {
      let response = null;
      try {
        const before = await page(version, current.pageURL);
        if (current.approvedOrigin && current.approvalRevision !== before.approvalRevision) throw problem("site");
        response = await api.runtime.sendNativeMessage(NATIVE_APP, { action: "applicationFields", pageURL: current.pageURL, keys });
        check(version);
        const after = await page(version, current.pageURL);
        if (current.approvedOrigin && current.approvalRevision !== after.approvalRevision) throw problem("site");
        if (!response || response.error || !response.fields || Array.isArray(response.fields)
          || typeof response.fields !== "object" || !Number.isFinite(response.expiresAt)
          || response.expiresAt <= now() || response.expiresAt > now() + 601000) throw problem("session");
        const values = Object.fromEntries(Object.entries(response.fields).filter(([key, value]) =>
          keys.includes(key) && (Object.hasOwn(SAVED_FIELDS, key) || (key === "hasHomeAddress" && Object.hasOwn(HOME_ANSWERS, value)))
          && typeof value === "string" && value.trim() && value.length <= 500));
        return await use(values, response.expiresAt);
      } finally { response = null; }
    }
    async function present(scan) {
      if (state.phase === "suspended") {
        message = MESSAGES.suspended;
      } else if (state.phase === "awaiting_confirmation" && scan.kind !== "receipt") {
        message = MESSAGES.awaiting_confirmation;
      } else {
        state.phase = ({ known: "ready", mapping: "mapping", manual: "paused", signature: "signature", receipt: "receipt" })[scan.kind];
        message = MESSAGES[state.phase];
      }
      await persist();
    }
    function assignmentsFor(input, scan) {
      if (!Array.isArray(input) || input.length > 30) throw problem("mapping");
      const ids = new Set(), keys = new Set();
      return input.map(item => {
        if (!item || typeof item.id !== "string" || !Object.hasOwn(SAVED_FIELDS, item.key)
          || ids.has(item.id) || keys.has(item.key) || !scan.fields.some(field => field.id === item.id && (!field.key || field.key === item.key)
            && (field.allowedKeys ? field.allowedKeys.includes(item.key) : !["ssn", "annualIncome", "annualIncomeYear"].includes(item.key)))) throw problem("mapping");
        ids.add(item.id); keys.add(item.key);
        return { id: item.id, key: item.key };
      });
    }
    function reviewedPlan(previewToken) {
      if (!plan || typeof previewToken !== "string" || previewToken !== plan.token) throw problem("changed");
      return plan;
    }
    async function fill(assignments, version, previewToken, remember = false) {
      const scan = reviewedPlan(previewToken);
      if (!["known", "mapping"].includes(scan.kind) || state.phase === "awaiting_confirmation") throw problem("changed");
      const selected = assignmentsFor(assignments, scan);
      if (!selected.length) throw problem("mapping");
      state.phase = "processing"; message = MESSAGES.processing;
      await persist(); check(version);
      const result = await nativeFields(scan, [...new Set(selected.map(item => item.key))], version, async (values, expiresAt) => {
        check(version);
        if (plan !== scan) throw problem("changed");
        return await script(scan, async (url, token, mapping, fields, expiry) =>
          await globalThis.SecondHandApplication.fill(document, url, token, mapping, fields, expiry),
        [scan.pageURL, scan.token, selected, values, Math.min(expiresAt, state.expiresAt)]);
      });
      check(version);
      if (remember === true && result.filled === selected.length && !result.skipped) await saveMappings(scan, selected, version);
      check(version);
      state.filled += Number.isInteger(result.filled) ? result.filled : 0;
      // The new review token captures the filled values, never the pre-fill form.
      const refreshed = await inspect(version);
      await present(refreshed);
      message = `${result.filled || 0} fields filled. Review the website and complete any missing answers before continuing.`;
      return view();
    }
    async function run(version) {
      if (!state || state.phase === "awaiting_confirmation") return view();
      let scan = await inspect(version);
      let homeAddressMessage = null;
      state.pages += 1;
      if (scan.kind === "known" && scan.canAnswerHomeAddress === true) {
        state.phase = "processing"; message = MESSAGES.processing;
        await persist(); check(version);
        const choiceScan = scan;
        const result = await nativeFields(choiceScan, ["hasHomeAddress"], version, async (values, expiresAt) => {
          check(version);
          if (plan !== choiceScan) throw problem("changed");
          // With no saved answer, the question stays with the applicant.
          if (!Object.hasOwn(values, "hasHomeAddress")) return null;
          const answer = values.hasHomeAddress;
          const outcome = await script(choiceScan, async (url, token, value, expiry) =>
            await globalThis.SecondHandApplication.answerHomeAddress(document, url, token, value, expiry),
          [choiceScan.pageURL, choiceScan.token, answer, Math.min(expiresAt, state.expiresAt)]);
          return { ...outcome, answer };
        });
        check(version);
        if (result) {
          // A saved answer that couldn't be selected safely is reported, not dropped.
          homeAddressMessage = result.filled === 1 ? `Home address ${HOME_ANSWERS[result.answer]} selected.` : HOME_LEFT;
          // At most one choice pass, then one text-fill pass. Newly revealed
          // fields require a fresh token in the same document and native grant.
          scan = await inspect(version);
          if (scan.documentID !== choiceScan.documentID || scan.pageURL !== choiceScan.pageURL) throw problem("changed");
        }
      }
      if (scan.kind === "known" && scan.fields.some(field => Object.hasOwn(SAVED_FIELDS, field.key))) {
        await fill(scan.fields.filter(field => Object.hasOwn(SAVED_FIELDS, field.key)).map(({ id, key }) => ({ id, key })), version, scan.token);
      } else {
        await present(scan);
      }
      if (homeAddressMessage) message = `${homeAddressMessage} ${message}`;
      return view();
    }
    async function act(input, version) {
      const scan = reviewedPlan(input.previewToken);
      const action = scan?.actions.find(item => item.id === input.actionID);
      if (!scan || !action || state.phase === "awaiting_confirmation") throw problem("changed");
      const submit = action.kind === "submit";
      if (submit && (scan.kind !== "signature" || input.approved !== true || state.phase !== "signature")) throw problem("approval");
      if (!submit && action.kind !== "continue") throw problem("approval");
      // Validate the sharing session without rescanning/replacing the token shown to the user.
      const nativeExpiry = await nativeFields(scan, ["firstName"], version, async (_values, expiresAt) => expiresAt);
      check(version);
      if (plan !== scan) throw problem("changed");
      const approvalExpiry = Math.min(nativeExpiry, state.expiresAt);
      state.phase = submit ? "awaiting_confirmation" : "navigating";
      message = MESSAGES[state.phase];
      await persist(); check(version);
      await page(version, scan.pageURL);
      if (plan !== scan) throw problem("changed");
      const token = scan.token;
      plan = null; // Each approval is consumed before attempting the page action.
      const result = await script(scan, async (url, previewToken, actionID, approved, expiresAt) =>
        await globalThis.SecondHandApplication.act(document, url, previewToken, actionID, approved, expiresAt),
      [scan.pageURL, token, action.id, submit && input.approved === true, approvalExpiry]);
      check(version);
      if (!result.attempted) throw problem("changed");
      // Single-page forms may render their next step without a navigation event.
      // Refresh the review, but never click Next or fill the new page by itself.
      if (scan.approvedOrigin) {
        const refreshed = await inspect(version);
        await present(refreshed);
      }
      return view();
    }
    async function command(input, version) {
      await initialized; check(version);
      if (input.command === "stop" || input.command === "expire") {
        await clear(input.command === "expire" ? "The assistance session expired. Enable a new session in SecondHand." : "Session stopped. No more fields will be filled.");
        return view();
      }
      if (state && state.expiresAt <= now()) { await clear("The assistance session expired. Enable a new session in SecondHand."); return view(); }
      if (input.command === "status") {
        await describeSite(version);
        if (state) { const scan = await inspect(version); await present(scan); }
        return view();
      }
      if (["approve-site", "remove-site", "forget-mappings"].includes(input.command)) {
        const current = await describeSite(version);
        if (!current || current.iowa || current.origin !== input.origin) throw problem("site");
        if (input.command === "forget-mappings") { await forgetMappings(current.origin); message = "Remembered matches removed for this website."; return view(); }
        if (input.command === "approve-site" && await api.permissions?.contains({origins: [current.origin + "/*"]}) !== true) throw problem("site");
        const action = input.command === "approve-site" ? "approveSite" : "removeSite";
        const response = await api.runtime.sendNativeMessage(NATIVE_APP, {action, pageURL: current.tab.url,
          ...(action === "approveSite" ? {includeSensitive: input.includeSensitive === true} : {})});
        check(version);
        if (response?.error || response?.origin !== current.origin) throw problem("session");
        if (action === "removeSite") {
          await clear("Website removed and session ended.");
          await forgetMappings(current.origin);
          await api.permissions?.remove({origins: [current.origin + "/*"]});
        }
        await describeSite(version);
        if (action === "approveSite") message = "Website approved. Start assistance to review and fill its fields.";
        return view();
      }
      if (input.command === "start") {
        if (state) throw problem("already_started");
        const current = await page(version);
        await nativeFields(current, ["firstName"], version, async (_values, expiresAt) => {
          check(version);
          state = { tabId: current.tabId, expiresAt, phase: "running", pages: 0, filled: 0, ...(current.approvedOrigin ? {origin: current.approvedOrigin} : {}) };
          await persist();
        });
        return run(version);
      }
      if (!state) throw problem("session");
      if (input.command === "pause") {
        state.phase = state.phase === "awaiting_confirmation" ? "awaiting_confirmation" : "suspended";
        plan = null; message = "Paused. Your saved information will not be filled until you resume.";
        await persist(); return view();
      }
      if (input.command === "resume") {
        if (state.phase === "awaiting_confirmation") throw problem("approval");
        state.phase = "running"; await persist(); return run(version);
      }
      if (state.phase === "suspended") throw problem("paused");
      if (input.command === "fill") return fill(input.assignments, version, input.previewToken, input.remember === true);
      if (input.command === "act") return act(input, version);
      if (input.command === "receipt") {
        reviewedPlan(input.previewToken);
        if (!plan || plan.kind !== "receipt" || input.confirmed !== true || typeof input.confirmationNumber !== "string"
          || !/^[\x20-\x7e]{1,100}$/.test(input.confirmationNumber.trim())) throw problem("receipt");
        const previous = plan;
        const scan = await inspect(version);
        if (scan.kind !== "receipt" || scan.pageURL !== previous.pageURL || scan.documentID !== previous.documentID) throw problem("receipt");
        await nativeFields(scan, ["firstName"], version, async () => undefined);
        await page(version, scan.pageURL);
        if (plan !== scan) throw problem("changed");
        const response = await api.runtime.sendNativeMessage(NATIVE_APP, { action: "recordReceipt", pageURL: scan.pageURL,
          confirmationNumber: input.confirmationNumber.trim(), receiptID: uuid() });
        check(version);
        if (!response || response.recorded !== true) throw problem("receipt");
        await clear("Confirmation saved. Unlock SecondHand to add the submission to your timeline.");
        return view();
      }
      throw problem("command");
    }
    function cancelPage() {
      if (!state) return Promise.resolve();
      // This runs outside the action queue so a long, scrolling fill can be interrupted.
      return api.scripting.executeScript({ target: { tabId: state.tabId, frameIds: [0] },
        func: () => globalThis.SecondHandApplication?.cancel(document) }).catch(() => {});
    }
    function dispatch(input) {
      if (["stop", "pause", "start", "expire", "remove-site"].includes(input.command)) generation += 1;
      const canceling = ["stop", "pause", "expire", "remove-site"].includes(input.command) ? cancelPage() : Promise.resolve();
      const version = generation;
      const operation = chain.then(async () => {
        try { await canceling; return await command(input, version); }
        catch (error) {
          if (error.code === "canceled") return view();
          if (error.code === "expired") { await clear("The assistance session expired. Enable a new session in SecondHand."); return view(); }
          const messages = {
            wrong_page: "Open an approved HTTPS form page in this tab. Sign-in, payment and account pages stay manual.",
            site: "Allow this exact website in Safari and SecondHand before filling. Stop the session before changing websites.",
            wrong_tab: "This session belongs to another tab. Return to that tab, or stop this session first.",
            session: "Unlock SecondHand and enable a new application-assistance session.",
            paused: "Resume assistance before filling or continuing this page.",
            mapping: "Select each saved detail at most once and leave uncertain fields unselected.",
            approval: "Review the current page again before approving an action. A submission will never be retried automatically.",
            receipt: "Check the confirmation on Iowa’s website and enter its confirmation number.",
            already_started: "A session is already open. Stop it before starting another."
          };
          message = messages[error.code] || "The page changed or could not be checked. Review it, then check the page again.";
          plan = null;
          if (state && !["awaiting_confirmation", "suspended"].includes(state.phase)) state.phase = "paused";
          await persist();
          return { ...view(), error: error.code || "unavailable" };
        }
      });
      chain = operation.catch(() => {});
      return operation;
    }
    function fromPopup(_message, sender) {
      return sender?.id === api.runtime.id && sender.url === api.runtime.getURL("popup.html") && !sender.tab;
    }
    function install() {
      api.runtime.onMessage.addListener((input, sender) => {
        if (!fromPopup(input, sender) || !input || !["status", "start", "resume", "pause", "stop", "fill", "act", "receipt", "approve-site", "remove-site", "forget-mappings"].includes(input.command)) return undefined;
        return dispatch(input);
      });
      api.permissions?.onRemoved?.addListener(() => { if (state) dispatch({command: "pause"}); });
      api.tabs.onActivated?.addListener(info => {
        if (state && info.tabId !== state.tabId) dispatch({ command: "pause" });
      });
      api.tabs.onRemoved?.addListener(tabId => { if (state?.tabId === tabId) dispatch({ command: "stop" }); });
      api.tabs.onUpdated.addListener((tabId, change) => {
        if (!state || state.tabId !== tabId) return;
        if (change.status === "loading" || change.url) { generation += 1; plan = null; }
        if (change.status === "complete" && ["running", "navigating"].includes(state.phase)) {
          const version = generation;
          const operation = chain.then(async () => {
            await initialized;
            if (state && ["running", "navigating"].includes(state.phase)) {
              try { await run(version); }
              catch { if (state && state.phase !== "awaiting_confirmation") { state.phase = "paused"; plan = null; message = MESSAGES.paused; await persist(); } }
            }
          });
          chain = operation.catch(() => {});
        }
      });
      return controller;
    }
    const controller = { dispatch, install, fromPopup };
    return controller;
  }
  const exported = { createWorkflow, SAVED_FIELDS, STORAGE_KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  else { root.SecondHandWorkflow = exported; if (root.browser) createWorkflow(root.browser).install(); }
})(globalThis);

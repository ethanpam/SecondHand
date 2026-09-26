/* Guided application operations. Runs only in Safari's isolated extension world.
 * Known Iowa fields reuse the desktop's inspected schema. Other fields require
 * an explicit user mapping. No saved answers, DOM snapshots, or approval tokens
 * are persisted. A submit click is an attempt, never proof of submission. */
(function (root) {
  "use strict";
  if (root.SecondHandApplication && typeof module === "undefined") return;
  const mapper = typeof module !== "undefined" ? require("./field-mapper.js") : root.SecondHandAutofill;
  const iowa = typeof module !== "undefined" ? require("../../../extension/iowa-adapter.js") : root.SecondHandIowa;
  const keys = new Set(["firstName", "middleName", "lastName", "email", "homePhone", "mobilePhone",
    "addressLine1", "addressLine2", "city", "state", "postalCode", "monthlyIncome", "monthlyHousingCost"]);
  const documents = new WeakMap();
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const words = value => String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
  const forbidden = /\b(ssn|social security|birth|dob|signature|sign here|check to sign|certif\w*|attest\w*|password|captcha|security code|verification code|one time|username|user name|account number|routing number)\b/i;
  const otherPerson = /\b(spouse|child|children|dependent|household member|family member|other person|other member|representative|assisting|employer)\b/i;
  const blockedRoute = /signup|register|registration|createaccount|createanaccount|account|profile|login|logon|signin|authentication|password|recovery|logout/;

  function isPortalURL(raw) {
    if (typeof raw !== "string" || raw.length > 1000 || !/^https:\/\/hhsservices\.iowa\.gov(?::443)?\/apspssp\/ssp\.portal\/applyForBenefits\/[A-Za-z][A-Za-z0-9_-]*(\/[A-Za-z][A-Za-z0-9_-]*)*$/.test(raw)) return false;
    try {
      const url = new URL(raw);
      return url.pathname.slice("/apspssp/ssp.portal/applyForBenefits/".length).length <= 200
        && !url.search && !url.hash && !blockedRoute.test(url.pathname.toLowerCase().replace(/[^a-z0-9]/g, ""));
    } catch { return false; }
  }

  function validDocument(doc, url) {
    return isPortalURL(url) && doc.defaultView?.location.href === url && doc.defaultView.top === doc.defaultView;
  }

  function rendered(element, doc) {
    if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      const style = doc.defaultView.getComputedStyle(node);
      if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
  }

  function exposed(element, doc) {
    if (!rendered(element, doc)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.left < 0 || rect.top < 0 || rect.right > doc.defaultView.innerWidth || rect.bottom > doc.defaultView.innerHeight) return false;
    if (typeof doc.elementFromPoint === "function") {
      const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!top || (top !== element && !element.contains(top))) return false;
    }
    return true;
  }

  function labels(element, doc) {
    const list = Array.from(element.labels || [], label => {
      const copy = label.cloneNode(true);
      copy.querySelectorAll("input, select, textarea, button").forEach(control => control.remove());
      return copy.textContent;
    });
    if (element.getAttribute("aria-label")) list.push(element.getAttribute("aria-label"));
    const ids = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (ids.length) list.push(ids.map(id => doc.getElementById(id)?.textContent || "").join(" "));
    return [...new Set(list.map(value => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
  }

  function context(element) {
    const names = [];
    let branch = element;
    for (let node = element.parentElement; node && node.tagName !== "BODY"; node = node.parentElement) {
      names.push(words(`${node.id} ${node.getAttribute("name") || ""} ${node.getAttribute("aria-label") || ""}`));
      const children = Array.from(node.children);
      const heading = children.slice(0, children.indexOf(branch)).reverse().find(child => child.matches("legend,h1,h2,h3,h4,h5,h6"));
      if (heading) names.push(heading.textContent);
      branch = node;
    }
    return names.join(" ");
  }

  function safeForm(form, doc, url, actionElement) {
    if (!form || form.ownerDocument !== doc || !form.isConnected) return false;
    const target = actionElement?.getAttribute("formtarget") || form.getAttribute("target");
    if (target && target.toLowerCase() !== "_self") return false;
    const action = actionElement?.getAttribute("formaction") || form.getAttribute("action") || url;
    try { return isPortalURL(new URL(action, doc.baseURI || url).href); } catch { return false; }
  }

  function pageContext(doc, url) {
    const headings = Array.from(doc.querySelectorAll("h1,h2,h3"))
      .filter(element => rendered(element, doc)).map(element => normalize(element.textContent));
    const inputs = Array.from(doc.querySelectorAll("input,select,textarea"));
    const challenge = inputs.some(element => rendered(element, doc) &&
      (element.type === "password" || /captcha|one.?time|security.?code|verification.?code|\botp\b/i.test(
        words(`${element.id} ${element.name} ${labels(element, doc).join(" ")}`))));
    const challengeFrame = Array.from(doc.querySelectorAll("iframe")).some(element => rendered(element, doc)
      && /captcha|challenge/i.test(`${element.title} ${element.getAttribute("src") || ""}`));
    if (challenge || challengeFrame || headings.some(heading => /^(sign in|log in|create an? account|account registration)/.test(heading))) {
      return { kind: "manual", title: "Sign in or complete verification", reason: "Complete this step on Iowa’s website, then resume." };
    }
    if (headings.some(heading => /^(e[ -]?signature|electronic signature|sign your application)$/.test(heading))) {
      return { kind: "signature", title: "Review and sign your application", reason: "Review the complete application and sign on Iowa’s website. Submission needs your separate approval." };
    }
    if (headings.some(heading => /^(application (submitted|confirmation)|submission confirmation|confirmation)$/.test(heading))) {
      return { kind: "receipt", title: "Check your submission confirmation", reason: "Copy the confirmation number from Iowa’s receipt. A button click alone does not confirm submission." };
    }
    const sensitive = /\b(signature|signing|sign here|sign your|review and sign|certif\w*|attest\w*|consent|agree|authorize|submit\w*|finali[sz]\w*)\b/i;
    const sensitiveControls = inputs.some(element => rendered(element, doc)
      && sensitive.test(words(`${element.id} ${element.name} ${labels(element, doc).join(" ")}`)));
    const sensitiveActions = Array.from(doc.querySelectorAll("form,button,input[type=submit],input[type=button]"))
      .some(element => sensitive.test(words(element.getAttribute("action") || element.getAttribute("formaction") || "")));
    if (headings.some(heading => sensitive.test(heading)) || sensitiveControls || sensitiveActions
      || sensitive.test(words(new URL(url).pathname.split("/").pop()))) {
      return { kind: "manual", title: "Review this step on Iowa’s website", reason: "This consent or submission step is not recognized. Complete it on the website; the assistant will not guess which action to take." };
    }
    // Program choices, preliminary consent, helpers and upload screens never receive profile data.
    if (/\/(guestLogin|selectHouseholdInfo|letsGetStarted)\/?$/.test(new URL(url).pathname)
      || headings.some(heading => /^(let.s get started|household application information|assisting organization or person|verification documents|upload documents)/.test(heading))) {
      return { kind: "manual", title: "Your answer is needed", reason: "Complete program choices, consent, or documents on the website, then resume." };
    }
    if (mapper.isAllowedURL(url) && mapper.recognizedForm(doc)) {
      return { kind: "known", title: "Applicant information", reason: "Names, typed phone numbers, and home address use the inspected Iowa form mapping." };
    }
    return { kind: "mapping", title: "Choose saved answers for this page", reason: "This page has no verified automatic mapping. Match each field yourself, or complete it on the website." };
  }

  function eligible(element, doc, url) {
    if (!rendered(element, doc) || !safeForm(element.form, doc, url) || element.matches(":disabled")
      || element.readOnly || element.multiple) return false;
    if (!((element.tagName === "INPUT" && ["text", "email", "tel", "number"].includes(element.type)) || element.tagName === "SELECT")) return false;
    const names = labels(element, doc);
    if (!names.length || names.some(name => name.length > 180 || forbidden.test(words(name)))) return false;
    if (forbidden.test(words(`${element.id} ${element.name} ${element.autocomplete}`))
      || otherPerson.test(words(`${element.id} ${element.name} ${names.join(" ")} ${context(element)}`))) return false;
    return true;
  }

  function fieldIdentity(element, doc) {
    return JSON.stringify([element.tagName, element.type, element.id, element.name, labels(element, doc),
      context(element), element.form?.id, element.form?.getAttribute("action"), element.form?.getAttribute("target"),
      element.getAttribute("autocomplete"), element.getAttribute("maxlength"),
      element.tagName === "SELECT" ? Array.from(element.options, option => [option.value, option.textContent, option.disabled]) : null]);
  }

  function bindings(doc, url, kind) {
    const known = kind === "known" ? mapper.candidates(doc, true) : new Map();
    const all = Array.from(doc.querySelectorAll("input,select"));
    const result = [];
    let ambiguous = 0;
    let populated = 0;
    for (const element of all) {
      if (!eligible(element, doc, url)) continue;
      let key = null;
      for (const [candidate, matches] of known) {
        if (matches.includes(element)) {
          if (matches.length !== 1) { ambiguous++; key = false; }
          else key = candidate;
          break;
        }
      }
      if (key === false) continue;
      if (String(element.value || "").trim()) { populated++; continue; }
      // Unmapped applicant controls remain an explicit choice, even on the known page.
      result.push({ element, key, identity: fieldIdentity(element, doc), label: labels(element, doc).join(" / ").slice(0, 180), type: element.type });
    }
    return { result, ambiguous, populated };
  }

  function actionBindings(doc, url, kind) {
    if (["manual", "receipt"].includes(kind)) return [];
    // The real Iowa form puts required markers in labels, not HTML attributes.
    // Reuse the laptop adapter's inspected button + conditional-question checks.
    if (kind === "known" && !iowa?.probePage(doc, url).canAdvance) return [];
    const result = [];
    for (const element of doc.querySelectorAll('button,input[type="submit"],input[type="button"]')) {
      if (!rendered(element, doc) || element.matches(":disabled") || !safeForm(element.form, doc, url, element)) continue;
      const label = String(element.getAttribute("aria-label") || (element.tagName === "INPUT" ? element.value : element.textContent) || "").replace(/\s+/g, " ").trim();
      const text = normalize(label);
      if (kind === "known" && text !== "save and continue") continue;
      if (kind === "signature") {
        if (text === "submit application") result.push({ element, label, kind: "submit" });
      } else if (["save and continue", "save & continue", "continue", "next"].includes(text)) {
        result.push({ element, label, kind: "continue" });
      }
    }
    // Never pick one of several competing Continue/Submit controls.
    return result.length === 1 ? result : [];
  }

  function formComplete(form, doc) {
    const groups = new Map();
    for (const control of Array.from(form.elements)) {
      if (!rendered(control, doc) || control.matches(":disabled") || !["INPUT", "SELECT", "TEXTAREA"].includes(control.tagName)) continue;
      if (control.getAttribute("aria-invalid") === "true" || (control.willValidate && !control.validity.valid)) return false;
      const marked = control.required || control.getAttribute("aria-required") === "true"
        || Array.from(control.labels || []).some(label => /\*/.test(label.textContent));
      if (["radio", "checkbox"].includes(control.type)) {
        const legendRequired = /\*/.test(control.closest("fieldset")?.querySelector("legend")?.textContent || "");
        if (control.type === "radio" || marked || legendRequired) {
          if (!control.name) { if (!control.checked) return false; }
          else {
            const group = groups.get(control.name) || [];
            group.push(control); groups.set(control.name, group);
          }
        }
      } else if (marked && !String(control.value || "").trim()) return false;
    }
    if (Array.from(groups.values()).some(group => !group.some(control => control.checked))) return false;
    return !Array.from(form.querySelectorAll('[role="alert"], .error, .errors, .errorMessage'))
      .some(element => rendered(element, doc) && element.textContent.trim());
  }

  function snapshot(doc) {
    // Private, short-lived comparison only. Never returned to popup or storage.
    return {
      elements: Array.from(doc.querySelectorAll("input,select,textarea,button")),
      data: Array.from(doc.querySelectorAll("input,select,textarea,button"), element => JSON.stringify([
        element.tagName, element.type, element.id, element.name, element.value, element.checked,
        element.disabled, element.readOnly, element.required, element.outerHTML,
        element.form?.getAttribute("action"), element.form?.getAttribute("target")
      ])),
      headings: Array.from(doc.querySelectorAll("h1,h2,h3,legend"), element => element.textContent).join("\n"),
      html: doc.body?.innerHTML,
      base: doc.baseURI
    };
  }

  function unchanged(doc, before) {
    const after = snapshot(doc);
    return before.base === after.base && before.headings === after.headings && before.html === after.html
      && before.elements.length === after.elements.length
      && before.elements.every((element, index) => element === after.elements[index] && before.data[index] === after.data[index]);
  }

  function inspect(doc, url) {
    if (!validDocument(doc, url)) return { error: "unsupported_page" };
    let state = documents.get(doc);
    if (!state) { state = { documentID: doc.defaultView.crypto.randomUUID(), generation: 0 }; documents.set(doc, state); }
    state.pending = null;
    const page = pageContext(doc, url);
    const scan = ["known", "mapping"].includes(page.kind) ? bindings(doc, url, page.kind) : { result: [], populated: 0, ambiguous: 0 };
    const fields = scan.result.map((field, index) => ({ ...field, id: `field-${index}` }));
    const actions = actionBindings(doc, url, page.kind).map((action, index) => ({ ...action, id: `action-${index}` }));
    const token = doc.defaultView.crypto.randomUUID();
    state.pending = { token, url, generation: state.generation, created: Date.now(), fields, actions, kind: page.kind, snapshot: snapshot(doc) };
    return { token, documentID: state.documentID, pageURL: url, ...page,
      fields: fields.map(({ id, label, key, type }) => ({ id, label, key, type })),
      actions: actions.map(({ id, label, kind }) => ({ id, label, kind })),
      populated: scan.populated, ambiguous: scan.ambiguous };
  }

  function take(doc, url, token) {
    const state = documents.get(doc);
    const plan = state?.pending;
    if (state) state.pending = null;
    if (!plan || plan.token !== token || plan.url !== url || !validDocument(doc, url)
      || Date.now() - plan.created > 120_000 || pageContext(doc, url).kind !== plan.kind
      || !unchanged(doc, plan.snapshot)) return null;
    return plan;
  }

  function cancel(doc) {
    const state = documents.get(doc);
    if (state) { state.generation++; state.pending = null; }
    return { cancelled: true };
  }

  const cancelled = (doc, plan) => documents.get(doc)?.generation !== plan.generation;

  function formatValue(key, raw, element) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 500 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
    let value = raw.trim();
    if (key === "homePhone" || key === "mobilePhone") {
      let digits = value.replace(/[()\s.-]/g, "");
      if (/^\+?1\d{10}$/.test(digits)) digits = digits.replace(/^\+?1/, "");
      if (!/^\d{10}$/.test(digits)) return null;
      value = `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    if (key === "postalCode" && !/^\d{5}$/.test(value)) return null;
    if (["monthlyIncome", "monthlyHousingCost"].includes(key) && !/^\d+(\.\d{1,2})?$/.test(value)) return null;
    if (element.type === "email" && key !== "email") return null;
    if (element.type === "tel" && !["homePhone", "mobilePhone"].includes(key)) return null;
    if (element.type === "number" && !["monthlyIncome", "monthlyHousingCost"].includes(key)) return null;
    if (element.tagName === "SELECT") {
      const options = Array.from(element.options).filter(option => !option.disabled && option.value &&
        (normalize(option.value) === normalize(value) || normalize(option.textContent) === normalize(value)
          || (key === "state" && normalize(value) === "ia" && normalize(option.textContent) === "iowa")));
      return options.length === 1 ? options[0].value : null;
    }
    return element.maxLength >= 0 && value.length > element.maxLength ? null : value;
  }

  async function reveal(element, doc) {
    if (!rendered(element, doc)) return false;
    if (!exposed(element, doc)) {
      element.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "instant" });
      if (typeof doc.defaultView.requestAnimationFrame === "function") {
        await new Promise(resolve => doc.defaultView.requestAnimationFrame(resolve));
      }
    }
    return exposed(element, doc);
  }

  async function fill(doc, url, token, assignments, values, expiresAt) {
    const plan = take(doc, url, token);
    if (!plan || !["known", "mapping"].includes(plan.kind)) return { error: "preview_expired" };
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 601_000) return { error: "session_expired" };
    if (!Array.isArray(assignments) || !assignments.length || assignments.length > 30 || !values || typeof values !== "object" || Array.isArray(values)) return { error: "invalid_fields" };
    const selected = new Set();
    for (const assignment of assignments) {
      if (!assignment || Object.keys(assignment).sort().join(",") !== "id,key" || selected.has(assignment.id)
        || !keys.has(assignment.key) || !plan.fields.some(field => field.id === assignment.id && (!field.key || field.key === assignment.key))) return { error: "invalid_fields" };
      selected.add(assignment.id);
    }
    if (Object.entries(values).some(([key, value]) => !assignments.some(item => item.key === key) || typeof value !== "string" || value.length > 500)) return { error: "invalid_fields" };
    let filled = 0;
    let skipped = 0;
    for (const assignment of assignments) {
      const field = plan.fields.find(item => item.id === assignment.id);
      const element = field.element;
      if (cancelled(doc, plan) || !validDocument(doc, url) || Date.now() >= expiresAt || pageContext(doc, url).kind !== plan.kind) break;
      if (!eligible(element, doc, url) || String(element.value || "").trim() || fieldIdentity(element, doc) !== field.identity) { skipped++; continue; }
      if (field.key) {
        const fresh = mapper.candidates(doc, true).get(field.key);
        if (fresh?.length !== 1 || fresh[0] !== element) { skipped++; continue; }
      }
      const value = formatValue(assignment.key, values[assignment.key], element);
      if (value === null || !await reveal(element, doc)) { skipped++; continue; }
      // Scrolling/rendering is asynchronous. Repeat identity/context checks immediately before writing.
      if (cancelled(doc, plan) || !validDocument(doc, url) || Date.now() >= expiresAt || !eligible(element, doc, url)
        || pageContext(doc, url).kind !== plan.kind || String(element.value || "").trim()
        || fieldIdentity(element, doc) !== field.identity) { skipped++; continue; }
      if (field.key) {
        const fresh = mapper.candidates(doc, true).get(field.key);
        if (fresh?.length !== 1 || fresh[0] !== element) { skipped++; continue; }
      }
      const prototype = element.tagName === "SELECT" ? doc.defaultView.HTMLSelectElement.prototype : doc.defaultView.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
      element.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
      element.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
      if (element.value === value) filled++; else skipped++;
    }
    return { filled, skipped: skipped + Math.max(0, assignments.length - filled - skipped), needsInput: true };
  }

  async function act(doc, url, token, actionID, approvedSubmit, expiresAt) {
    const plan = take(doc, url, token);
    if (!plan) return { error: "preview_expired" };
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 601_000) return { error: "session_expired" };
    const action = plan.actions.find(item => item.id === actionID);
    if (!action || (action.kind === "submit" && approvedSubmit !== true)
      || (action.kind === "continue" && plan.kind === "signature")) return { error: "approval_required" };
    const element = action.element;
    const form = element.form;
    const fresh = actionBindings(doc, url, plan.kind);
    if (fresh.length !== 1 || fresh[0].element !== element || fresh[0].kind !== action.kind
      || !safeForm(form, doc, url, element) || !formComplete(form, doc) || !form.checkValidity()) return { error: "needs_input" };
    if (!await reveal(element, doc)) return { error: "needs_input" };
    if (cancelled(doc, plan) || Date.now() >= expiresAt || !validDocument(doc, url) || Date.now() - plan.created > 120_000 || !unchanged(doc, plan.snapshot) || !exposed(element, doc)
      || element.matches(":disabled") || !safeForm(form, doc, url, element) || !formComplete(form, doc) || !form.checkValidity()
      || pageContext(doc, url).kind !== plan.kind) return { error: "preview_expired" };
    // One token, one native click; browser validation and Iowa's handlers still run.
    // No requestSubmit fallback, direct HTTP request, automatic retry, or synthetic signature.
    element.click();
    return { attempted: true, kind: action.kind };
  }

  const api = Object.freeze({ isPortalURL, inspect, fill, act, cancel, formatValue });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SecondHandApplication = api;
})(globalThis);

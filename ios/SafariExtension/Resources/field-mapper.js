/* Conservative applicant prototype using the repository's live-inspected public
 * schema. Safari filling and authenticated renewal remain unvalidated.
 * This module executes in the extension's isolated world, never MAIN. */
(function (root) {
  "use strict";
  // Subset of the public applicant schema inspected for this repository on
  // 2026-09-26. Safari filling and authenticated renewal remain unvalidated.
  const definitions = Object.freeze({
    firstName: { id: "firstName", label: "First name", observed: "first name" },
    middleName: { id: "middleName", label: "Middle name", observed: "middle name" },
    lastName: { id: "lastName", label: "Last name", observed: "last name" },
    homePhone: { id: "phoneNumber", label: "Home phone number", observed: "home phone number (999)999-9999" },
    mobilePhone: { id: "otherPhoneNumber", label: "Mobile phone number", observed: "mobile phone number (999)999-9999" },
    addressLine1: { id: "addressLine1", label: "Home street address", observed: "home address line 1", address: true },
    addressLine2: { id: "addressLine2", label: "Home apartment / unit", observed: "home address line 2", address: true },
    city: { id: "city", label: "Home city", observed: "city", address: true },
    state: { id: "state", label: "Home state", observed: "state", address: true },
    postalCode: { id: "zipcode", label: "Home ZIP code", observed: "zip code (99999)", address: true }
  });
  const names = Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, value.label]));
  const normalLabel = value => String(value || "").replace(/\s+/g, " ").trim().replace(/\s*\*\s*$/, "").replace(/:$/, "").trim().toLowerCase();
  const safeSections = new Set(["enter personal information", "applicant's information", "contact information", "address information"]);
  const normalize = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const isSensitive = value => /ssn|socialsecurity|dateofbirth|birthdate|dob|income|salary|password|accountnumber|routingnumber/.test(normalize(value));
  const isAccountRoute = value => /signup|register|registration|createaccount|createanaccount|profile|login|logon|signin|authentication|password|recovery/.test(normalize(value));
  let pending = null;

  function isAllowedURL(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "hhsservices.iowa.gov"
        && (url.port === "" || url.port === "443") && !url.username && !url.password
        && url.pathname === "/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo"
        && !isAccountRoute(decodeURIComponent(url.pathname + url.search + url.hash));
    } catch { return false; }
  }

  function classify(hints) {
    const allText = [...hints.labels, hints.id, hints.name, hints.placeholder, hints.autocomplete, hints.groupLabel];
    if (allText.some(isSensitive)) return null;
    const labels = hints.labels.map(normalLabel).filter(Boolean);
    if (!labels.length) return null;
    const match = Object.entries(definitions).find(([key, definition]) =>
      hints.id === definition.id && hints.name === definition.id
      && labels.every(label => label === definition.observed)
      && (key === "state" ? hints.type === "select-one" : hints.type === "text")
      && (!definition.address || hints.homeContainer));
    if (!match) return null;
    // Autocomplete cannot substitute for the observed schema or change recipient.
    const autocomplete = String(hints.autocomplete || "").trim().toLowerCase();
    const expected = { firstName: "given-name", middleName: "additional-name", lastName: "family-name", homePhone: "tel", mobilePhone: "tel", addressLine1: "address-line1",
      addressLine2: "address-line2", city: "address-level2", state: "address-level1", postalCode: "postal-code" };
    if (autocomplete && !["on", "off", expected[match[0]]].includes(autocomplete)) return null;
    if (/mailing|shipping|billing/.test(normalize(hints.groupLabel))) return null;
    return match[0];
  }

  function hintsFor(element, document) {
    const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/)
      .filter(Boolean).map(id => document.getElementById(id)?.textContent || "");
    return {
      labels: [...Array.from(element.labels || [], label => {
        const copy = label.cloneNode(true);
        copy.querySelectorAll("input, select, textarea, button").forEach(control => control.remove());
        return copy.textContent || "";
      }),
        element.getAttribute("aria-label") || "", ...labelledBy],
      id: element.id, name: element.name, type: element.type,
      homeContainer: Boolean(element.closest("#personalInformation #homeAddrDiv")),
      groupLabel: (element.closest("fieldset")?.querySelector("legend")?.textContent || "")
        + " " + (element.closest("section")?.querySelector("h1, h2, h3, h4")?.textContent || ""),
      placeholder: element.getAttribute("placeholder") || "",
      autocomplete: element.getAttribute("autocomplete") || ""
    };
  }

  function isUsable(element, document, includeOffscreen = false) {
    const tag = element.tagName.toLowerCase();
    if (tag !== "input" && tag !== "select") return false;
    if (tag === "input" && element.type !== "text") return false;
    if (element.disabled || element.readOnly || element.multiple || !element.isConnected
      || element.matches(":disabled")
      || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (!element.getClientRects().length) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (!includeOffscreen && (rect.left < 0 || rect.top < 0
      || rect.right > document.defaultView.innerWidth || rect.bottom > document.defaultView.innerHeight)) return false;
    if (!includeOffscreen && typeof document.elementFromPoint === "function") {
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!top || (top !== element && !element.contains(top))) return false;
    }
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = document.defaultView.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
        || Number(style.opacity) === 0) return false;
    }
    const legend = element.closest("fieldset")?.querySelector("legend")?.textContent || "";
    // Never infer that another person's field should receive the applicant's data.
    if (/householdmember|spouse|dependent|child|otherperson|othermember/.test(normalize(legend))) return false;
    return true;
  }

  function candidates(document, includeOffscreen = false) {
    const groups = new Map();
    const form = recognizedForm(document);
    if (!form) return groups;
    for (const element of document.querySelectorAll("input, select")) {
      if (element.form !== form || !isUsable(element, document, includeOffscreen) || !safeContext(element)) continue;
      const key = classify(hintsFor(element, document));
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(element);
    }
    return groups;
  }

  function scan(document, pageURL) {
    pending = null;
    if (!isAllowedURL(pageURL) || document.defaultView.location.href !== pageURL
      || document.defaultView.top !== document.defaultView) return { error: "unsupported_page" };
    if (isAccountPage(document)) return { error: "account_page" };
    if (!recognizedForm(document)) return { error: "unrecognized_form" };
    const fields = [];
    let ambiguous = 0;
    let populated = 0;
    for (const [key, elements] of candidates(document)) {
      if (elements.length !== 1) { ambiguous += elements.length; continue; }
      const element = elements[0];
      if (String(element.value || "").trim()) { populated += 1; continue; }
      fields.push({ key, element });
    }
    const token = document.defaultView.crypto.randomUUID();
    pending = { token, pageURL, document, fields, createdAt: Date.now() };
    return { token, pageURL, fields: fields.map(({ key }) => ({ key, label: names[key] })), ambiguous, populated };
  }

  function fill(document, pageURL, token, values, expiresAt) {
    const plan = pending;
    pending = null; // A preview may be used only once, even when validation fails.
    if (!plan || plan.token !== token || plan.document !== document || plan.pageURL !== pageURL
      || !isAllowedURL(pageURL) || document.defaultView.location.href !== pageURL
      || document.defaultView.top !== document.defaultView
      || isAccountPage(document) || !recognizedForm(document)
      || Date.now() - plan.createdAt > 120_000
      || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 601_000
      || !values || typeof values !== "object" || Array.isArray(values)) return { error: "preview_expired" };
    const known = new Set(plan.fields.map(field => field.key));
    if (Object.keys(values).some(key => !known.has(key) || typeof values[key] !== "string"
      || values[key].length > 500)) return { error: "invalid_fields" };
    let filled = 0;
    let skipped = 0;
    for (const { key, element } of plan.fields) {
      // Recompute before each field; an input event may change the form or URL.
      const current = candidates(document).get(key);
      const value = values[key];
      if (document.defaultView.location.href !== pageURL || Date.now() >= expiresAt || isAccountPage(document)) break;
      if (!value?.trim() || !current || current.length !== 1 || current[0] !== element
        || String(element.value || "").trim()) { skipped += 1; continue; }
      if (/[\u0000-\u001f]/.test(value) || (key === "postalCode" && !/^\d{5}$/.test(value))) { skipped += 1; continue; }
      let nextValue = value;
      if (key === "homePhone" || key === "mobilePhone") {
        let digits = value.replace(/[()\s.-]/g, "");
        if (/^\+?1\d{10}$/.test(digits)) digits = digits.replace(/^\+?1/, "");
        if (!/^\d{10}$/.test(digits)) { skipped += 1; continue; }
        nextValue = `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
      }
      if (element.tagName.toLowerCase() === "select") {
        const options = Array.from(element.options).filter(option => !option.disabled && option.value
          && (option.value.toLowerCase() === value.toLowerCase()
            || option.textContent.trim().toLowerCase() === value.toLowerCase()
            || (key === "state" && value.toUpperCase() === "IA" && option.textContent.trim().toLowerCase() === "iowa")));
        if (options.length !== 1) { skipped += 1; continue; }
        nextValue = options[0].value;
      } else if (element.maxLength >= 0 && nextValue.length > element.maxLength) { skipped += 1; continue; }
      // Use the native setter so controlled forms can receive input/change events.
      const prototype = element.tagName.toLowerCase() === "select"
        ? document.defaultView.HTMLSelectElement.prototype : document.defaultView.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) { skipped += 1; continue; }
      setter.call(element, nextValue);
      element.dispatchEvent(new document.defaultView.Event("input", { bubbles: true }));
      element.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
      filled += 1;
    }
    return { filled, skipped };
  }

  function isAccountPage(document) {
    if (Array.from(document.querySelectorAll("input")).some(element => element.type === "password")) return true;
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"), element => element.textContent || "");
    return headings.some(isAccountRoute);
  }

  function recognizedForm(document) {
    const forms = Array.from(document.querySelectorAll("form#personalInformation"));
    if (forms.length !== 1 || forms[0].getAttribute("action") !== "enterPersonalInfo") return null;
    const heading = Array.from(document.querySelectorAll("h1, h2, h3")).some(element => {
      if (normalLabel(element.textContent) !== "enter personal information") return false;
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        const style = document.defaultView.getComputedStyle(node);
        if (node.hidden || node.getAttribute("aria-hidden") === "true" || style.display === "none"
          || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
      }
      return true;
    });
    return heading ? forms[0] : null;
  }

  function safeContext(element) {
    let branch = element;
    for (let node = element.parentElement; node && node.tagName !== "BODY"; node = node.parentElement) {
      const identity = normalize(`${node.id || ""} ${node.getAttribute("name") || ""} ${node.getAttribute("aria-label") || ""}`);
      if (/mailing|shipping|billing|householdmember|spouse|dependent|child|otherperson|othermember|representative|employer|signature/.test(identity)) return false;
      const children = Array.from(node.children);
      if (node.matches('fieldset, section, [role="group"], [role="region"]')) {
        const heading = children.find(child => child.matches("legend, h1, h2, h3, h4, h5, h6"));
        const label = normalLabel(node.getAttribute("aria-label") || heading?.textContent);
        if (label && !safeSections.has(label)) return false;
      }
      const preceding = children.slice(0, children.indexOf(branch)).reverse();
      const heading = preceding.find(child => child.matches("legend, h1, h2, h3, h4, h5, h6"));
      if (heading && !safeSections.has(normalLabel(heading.textContent))) return false;
      branch = node;
    }
    return true;
  }

  const api = Object.freeze({ isAllowedURL, classify, scan, fill, candidates, recognizedForm });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SecondHandAutofill = api;
})(globalThis);

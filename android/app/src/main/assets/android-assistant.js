/* Loaded only in SecondHand's named, isolated WebView world. No website listener,
 * storage, network, or native vault endpoint. Native UI initiates every command. */
(function (root) {
  "use strict";
  if (root !== root.top || root.SecondHandAndroid || !root.SecondHandBridge || !root.SecondHandApplication) return;
  const engine = root.SecondHandApplication;
  const documentID = root.crypto.randomUUID();
  const seen = new Set();
  let generation = 0;
  let busy = false;
  const send = message => root.SecondHandBridge.postMessage(JSON.stringify(message));
  const safeError = error => ["preview_expired", "needs_input", "session_expired", "approval_required",
    "invalid_fields", "unsupported_page"].includes(error) ? error : "changed";

  function cancel() {
    generation++;
    engine.cancel(root.document);
  }

  async function command(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)
      || typeof request.id !== "string" || !/^[a-f0-9-]{36}$/.test(request.id)
      || request.documentID !== documentID || !Number.isInteger(request.generation)
      || !["inspect", "fill", "act"].includes(request.operation)
      || request.pageURL !== root.location.href || !engine.isPortalURL(request.pageURL)) return;
    const envelope = { type: "result", id: request.id, documentID, generation: request.generation };
    if (seen.has(request.id) || seen.size >= 256 || busy) {
      send({ ...envelope, error: "changed" }); return;
    }
    seen.add(request.id);
    const original = generation;
    busy = true;
    try {
      let result;
      if (request.operation === "inspect") {
        result = engine.inspect(root.document, request.pageURL);
      } else if (request.operation === "fill") {
        result = await engine.fill(root.document, request.pageURL, request.token,
          request.assignments, request.values, request.expiresAt);
      } else {
        result = await engine.act(root.document, request.pageURL, request.token,
          request.actionID, request.approved === true, request.expiresAt);
      }
      if (original !== generation || request.pageURL !== root.location.href) return;
      if (result?.error) send({ ...envelope, error: safeError(result.error) });
      else send({ ...envelope, result });
    } catch {
      if (original === generation) send({ ...envelope, error: "changed" });
    } finally {
      busy = false;
      // Never retain saved answers in the transport after the engine returns.
      if (request.values) request.values = null;
    }
  }

  Object.defineProperty(root, "SecondHandAndroid", {
    value: Object.freeze({ command, cancel }), writable: false, configurable: false
  });
  send({ type: "ready", documentID, pageURL: root.location.href });
})(globalThis);

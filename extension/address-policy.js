/* User-selected first-suggestion policy. No addresses, DOM, network, or storage.
 * Only a verified adapter may identify suggestions separately from the original
 * entered address. This policy does not compare or validate postal addresses. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.SecondHandAddressPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const REASONS = Object.freeze({ INVALID_REQUEST: 'INVALID_REQUEST', INVALID_SCOPE: 'INVALID_SCOPE',
    INVALID_CANDIDATES: 'INVALID_CANDIDATES', NO_CANDIDATES: 'NO_CANDIDATES', ERRORS_PRESENT: 'ERRORS_PRESENT',
    WARNINGS_PRESENT: 'WARNINGS_PRESENT', UNKNOWN_CONTROLS: 'UNKNOWN_CONTROLS', FIRST_HOME_SUGGESTION: 'FIRST_HOME_SUGGESTION' });
  function dataObject(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)) && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
    });
  }
  const result = (reason, eligible = false) => Object.freeze({ eligible, reason, candidateIndex: eligible ? 0 : null });
  /** No address values accepted or returned. Contiguous metadata comes only from
   * the verified possible-matches section; an entered-original is never eligible.
   * More than one suggestion is allowed: the user explicitly chose the first. */
  function decide(input) {
    try {
      if (!dataObject(input, ['scope', 'candidates', 'hasWarnings', 'hasErrors', 'hasUnknownControls']) ||
          ['hasWarnings', 'hasErrors', 'hasUnknownControls'].some(key => typeof input[key] !== 'boolean')) return result(REASONS.INVALID_REQUEST);
      if (input.scope !== 'home') return result(REASONS.INVALID_SCOPE);
      const candidates = input.candidates;
      if (!Array.isArray(candidates) || Object.getPrototypeOf(candidates) !== Array.prototype || candidates.length > 8 ||
          Reflect.ownKeys(candidates).length !== candidates.length + 1) return result(REASONS.INVALID_CANDIDATES);
      for (let index = 0; index < candidates.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(candidates, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return result(REASONS.INVALID_CANDIDATES);
        const candidate = descriptor.value;
        if (!dataObject(candidate, ['id', 'index', 'role']) || candidate.id !== `homeAddressIndex${index}` ||
            candidate.index !== index || candidate.role !== 'suggestion') return result(REASONS.INVALID_CANDIDATES);
      }
      if (input.hasErrors) return result(REASONS.ERRORS_PRESENT);
      if (input.hasWarnings) return result(REASONS.WARNINGS_PRESENT);
      if (input.hasUnknownControls) return result(REASONS.UNKNOWN_CONTROLS);
      if (!candidates.length) return result(REASONS.NO_CANDIDATES);
      return result(REASONS.FIRST_HOME_SUGGESTION, true);
    } catch { return result(REASONS.INVALID_REQUEST); }
  }
  return Object.freeze({ decide, REASONS });
});

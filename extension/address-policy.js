/* Pure address-choice policy. No DOM, network, storage, or automatic actions.
 * A future verified adapter must supply the address actually submitted to Iowa,
 * not a stale vault address, and extract home/mailing choices separately.
 * This comparator does not prove that an address exists or is deliverable. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.SecondHandAddressPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const COMPONENTS = Object.freeze(['line1', 'line2', 'city', 'state', 'zip']);
  const REASONS = Object.freeze({
    INVALID_REQUEST: 'INVALID_REQUEST',
    INVALID_SCOPE: 'INVALID_SCOPE',
    INVALID_SUBMITTED_ADDRESS: 'INVALID_SUBMITTED_ADDRESS',
    INVALID_CANDIDATES: 'INVALID_CANDIDATES',
    INVALID_CANDIDATE: 'INVALID_CANDIDATE',
    DUPLICATE_CANDIDATE_ID: 'DUPLICATE_CANDIDATE_ID',
    ERRORS_PRESENT: 'ERRORS_PRESENT',
    WARNINGS_PRESENT: 'WARNINGS_PRESENT',
    NO_CANDIDATES: 'NO_CANDIDATES',
    MULTIPLE_CANDIDATES: 'MULTIPLE_CANDIDATES',
    ADDRESS_DIFFERENT: 'ADDRESS_DIFFERENT',
    SINGLE_EQUIVALENT_CANDIDATE: 'SINGLE_EQUIVALENT_CANDIDATE'
  });
  const MAX_CANDIDATES = 8;
  const LIMITS = Object.freeze({ line1: 160, line2: 160, city: 80, state: 16, zip: 24 });
  const US_STATES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' '));
  // Permit ordinary whitespace formatting but reject control/invisible/bidi
  // characters that could conceal a substantive difference.
  const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
  const SAFE_WHITESPACE = /[ \t\r\n\u00a0]+/g;

  function dataObject(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return false;
    // Accessors are not structured input. Do not execute one while comparing.
    return keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') && descriptor.enumerable;
    });
  }

  function candidateArray(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_CANDIDATES) return false;
    if (Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) return false;
    }
    return true;
  }

  function normalize(value) {
    // ASCII case only: no Unicode case-fold expansion, transliteration,
    // punctuation removal, token reordering, or abbreviation replacement.
    return value.replace(SAFE_WHITESPACE, ' ').replace(/^ +| +$/g, '').replace(/[a-z]/g, letter => letter.toUpperCase());
  }

  function address(value) {
    if (!dataObject(value, COMPONENTS)) return null;
    const result = Object.create(null);
    for (const component of COMPONENTS) {
      const text = value[component];
      if (typeof text !== 'string' || text.length > LIMITS[component] || UNSAFE_TEXT.test(text) || /\s/.test(text.replace(SAFE_WHITESPACE, ''))) return null;
      result[component] = normalize(text);
      // Missing unit/address line 2 must be represented explicitly as ''.
      if (component !== 'line2' && !result[component]) return null;
    }
    // The currently observed Iowa state lists contain the fifty US states.
    if (!US_STATES.has(result.state) || !/^\d{5}(?:-\d{4})?$/.test(result.zip)) return null;
    return result;
  }

  function result(reason, differingComponents = [], eligible = false) {
    return Object.freeze({
      eligible, reason, candidateIndex: eligible ? 0 : null,
      differingComponents: Object.freeze([...differingComponents])
    });
  }

  /**
   * decide({scope:'home'|'mailing', submitted:{line1,line2,city,state,zip},
   *   candidates:[{id,address:{line1,line2,city,state,zip}}],
   *   hasWarnings:boolean, hasErrors:boolean})
   *
   * Every key is mandatory; unknown keys fail closed. Candidates must be verified
   * suggestions; exclude Iowa's entered-original display from this list. The
   * adapter must verify their role and bind them to the requested home/mail scope.
   * Candidate IDs are bounded opaque identifiers, never returned here.
   * Multiple candidates always pause, even if just one seems equivalent.
   * Only a unique, valid, warning-free equivalent candidate is eligible. The
   * caller must still verify the live controls and obtain action authorization.
   * No submitted strings, candidate IDs, or addresses are included in results.
   */
  function decide(input) {
    try {
      if (!dataObject(input, ['scope', 'submitted', 'candidates', 'hasWarnings', 'hasErrors']) ||
          typeof input.hasWarnings !== 'boolean' || typeof input.hasErrors !== 'boolean') return result(REASONS.INVALID_REQUEST);
      if (!['home', 'mailing'].includes(input.scope)) return result(REASONS.INVALID_SCOPE);
      const submitted = address(input.submitted);
      if (!submitted) return result(REASONS.INVALID_SUBMITTED_ADDRESS);
      if (!candidateArray(input.candidates)) return result(REASONS.INVALID_CANDIDATES);
      const ids = new Set(), candidates = [];
      for (const candidate of input.candidates) {
        if (!dataObject(candidate, ['id', 'address']) || typeof candidate.id !== 'string' ||
            !/^[A-Za-z0-9_-]{1,80}$/.test(candidate.id)) return result(REASONS.INVALID_CANDIDATE);
        const parsed = address(candidate.address);
        if (!parsed) return result(REASONS.INVALID_CANDIDATE);
        if (ids.has(candidate.id)) return result(REASONS.DUPLICATE_CANDIDATE_ID);
        ids.add(candidate.id);
        candidates.push(parsed);
      }
      if (input.hasErrors) return result(REASONS.ERRORS_PRESENT);
      if (input.hasWarnings) return result(REASONS.WARNINGS_PRESENT);
      if (!candidates.length) return result(REASONS.NO_CANDIDATES);
      if (candidates.length !== 1) return result(REASONS.MULTIPLE_CANDIDATES);
      const differingComponents = COMPONENTS.filter(component => submitted[component] !== candidates[0][component]);
      if (differingComponents.length) return result(REASONS.ADDRESS_DIFFERENT, differingComponents);
      return result(REASONS.SINGLE_EQUIVALENT_CANDIDATE, [], true);
    } catch {
      // Malformed/exotic objects cannot cause caller code to choose a candidate.
      return result(REASONS.INVALID_REQUEST);
    }
  }

  return Object.freeze({ decide, COMPONENTS, REASONS });
});

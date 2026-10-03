/* Rules-based adapter for food-assistance forms on sites the applicant approved.
   Fills only confident matches, never overwrites an answer, and never touches
   passwords, payment cards, files, or CAPTCHAs. No network or storage. */
(function (root) {
  'use strict';
  // When two of SecondHand's registrations match a page (a site turned on by itself, and all
  // websites), this file loads twice in the same frame: the engine and the plan it holds are made once.
  if (typeof module === 'undefined' && root.SecondHandGeneric) return;
  // Saved profile fields a general site may receive, plus answers derived from them.
  const PROFILE_KEYS = Object.freeze(['firstName', 'middleName', 'lastName', 'suffix', 'birthDate', 'ssn', 'email', 'mobilePhone', 'homePhone', 'phone',
    'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors',
    'householdVeteran', 'householdDisability', 'monthlyEarnedIncome', 'monthlyOtherIncome', 'monthlyRent', 'monthlyUtilities', 'assetsOnHand',
    'monthlyMedicalExpenses', 'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare', 'programMedicaid']);
  const SOURCES = Object.freeze({ fullName: ['firstName', 'lastName'], phone: ['mobilePhone', 'homePhone', 'phone'],
    cityState: ['city', 'state'], cityZip: ['city', 'zip'], cityStateZip: ['city', 'state', 'zip'], fullAddress: ['addressLine1', 'addressLine2', 'city', 'state', 'zip'],
    ageRange: ['birthDate'], totalMonthlyIncome: ['monthlyEarnedIncome', 'monthlyOtherIncome'], annualIncome: ['monthlyEarnedIncome', 'monthlyOtherIncome'],
    anyoneSenior: ['householdSeniors'], iowaResident: ['state'], wantsHealthCoverage: ['programMedicaid'] });
  const GENERIC_KEYS = Object.freeze(['firstName', 'middleName', 'lastName', 'fullName', 'suffix', 'birthDate', 'ssn', 'email', 'phone',
    'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county', 'ageRange', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors',
    'householdVeteran', 'householdDisability', 'totalMonthlyIncome', 'annualIncome', 'monthlyRent', 'monthlyUtilities', 'assetsOnHand',
    'monthlyMedicalExpenses', 'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare', 'anyoneSenior', 'iowaResident',
    'wantsHealthCoverage']);
  const COMPOSITE_KEYS = Object.freeze(['cityState', 'cityZip', 'cityStateZip', 'fullAddress']);
  // Answers about a household member, worked out by the desktop from the household list. Only the
  // rules place them, and only in a box that asks for that member: never a guess, never an applicant box.
  const MEMBER_KEYS = Object.freeze(['studentNameGrade']);
  // A household count by age, worked out by the desktop from birth dates: "householdCount:0-5" or
  // "householdCount:60+", whole numbers 0 to 120 without leading zeros. shared/household.cjs reads them the same way.
  const BAND_KEY = /^householdCount:(0|[1-9]\d{0,2})(?:-(0|[1-9]\d{0,2})|(\+))$/;
  function isBandKey(key) {
    const match = typeof key === 'string' ? BAND_KEY.exec(key) : null;
    return Boolean(match) && Number(match[1]) <= 120 && (Boolean(match[3]) || (Number(match[2]) <= 120 && Number(match[2]) >= Number(match[1])));
  }
  // Keys the rules may place beyond the profile's own: composites, a member's answer, and band counts.
  const ruleOnlyKey = key => MEMBER_KEYS.includes(key) || isBandKey(key);
  // Answers that are only ever a guess for the applicant to review, however they were matched.
  const GUESS_KEYS = Object.freeze(['iowaResident']);
  const KIND = Object.freeze({ birthDate: 'date', email: 'email', phone: 'tel', state: 'state', ageRange: 'ageRange', householdSize: 'count', householdAdults: 'count',
    householdChildren: 'count', householdSeniors: 'count', householdVeteran: 'yesno', householdDisability: 'yesno', totalMonthlyIncome: 'money',
    annualIncome: 'money', monthlyRent: 'money', monthlyUtilities: 'money', assetsOnHand: 'money', monthlyMedicalExpenses: 'money',
    householdAllCitizens: 'yesno', householdLegalStatus: 'yesno', householdPregnant: 'yesno', householdMedicare: 'yesno', anyoneSenior: 'yesno',
    iowaResident: 'yesno', wantsHealthCoverage: 'yesno' });
  const AUTOCOMPLETE = Object.freeze({ 'given-name': 'firstName', 'additional-name': 'middleName', 'family-name': 'lastName', name: 'fullName',
    'honorific-suffix': 'suffix', email: 'email', tel: 'phone', 'tel-national': 'phone', 'street-address': 'addressLine1', 'address-line1': 'addressLine1',
    'address-line2': 'addressLine2', 'address-level2': 'city', 'address-level1': 'state', 'postal-code': 'zip', bday: 'birthDate' });
  // Household counts by age the profile keeps: children 0-17, adults 18-64, seniors 65+. Any other band
  // ("0-5", "18-59", "60+") is a band count the desktop works out from the household list (bandRule).
  const AGE_BANDS = Object.freeze({
    householdChildren: '(under|below|younger than) (age )?18|(0|zero) (to |through |thru )?17|17 (and|or) (under|younger)',
    householdAdults: '18 (to |through |thru )?64',
    householdSeniors: '65( ?\\+| (and|or) (older|over|above|up))?|(over|older than) (age )?64'
  });
  const IN_HOUSEHOLD = '( in (your |the )?(household|home))?( (who )?(are|is|live|lives|living)( in (your |the )?(household|home))?)?';
  const ANYONE = '(is )?(anyone|any(one| household)? member|at least one (household )?member)( (in|of) (your |the )?household)?';
  const counted = (who, band) => new RegExp(`^((number of|how many|total) )?${who}${IN_HOUSEHOLD}${band ? ` (ages? |aged )?(${band})( (years?|yrs?)( old| of age)?)?${IN_HOUSEHOLD}` : ''}$`);
  // Anchored phrases only: a question must say what it asks, not merely mention a word.
  const RULES = [
    [/^(first|given) name$|^first$/, 'firstName'],
    [/^middle (name|initial)$/, 'middleName'],
    [/^(last|family|sur) ?name$|^last$/, 'lastName'],
    [/^(full |legal |applicant )?name$|^(first (and )?last|full) name$|^name of (the )?head of household$|^head of household name$/, 'fullName'],
    [/^(date of birth|birth ?date|dob|birthday)( mm dd yyyy| date)?$/, 'birthDate'],
    [/^(age range|age group)$/, 'ageRange'],
    [/^(social security( number)?|ssn)$/, 'ssn'],
    [/^e ?mail( address)?$/, 'email'],
    [/^((cell|mobile|home|best|primary) )?(phone|telephone)( number)?$|^(mobile|cell) number$/, 'phone'],
    [/^(city (and )?state|ciudad (y )?estado)$/, 'cityState'],
    [/^(city (and )?(zip|zip code|zipcode|postal code)|ciudad (y )?codigo postal)$/, 'cityZip'],
    [/^(city (and )?state (and )?(zip|zip code|zipcode|postal code)|ciudad (y )?estado (y )?codigo postal)$/, 'cityStateZip'],
    [/^(complete |full )(physical |home |residential )?address( including (town|city|town city))?$|^direccion completa$/, 'fullAddress'],
    [/^(street |home )?address( line 1)?$|^street$/, 'addressLine1'],
    [/^address line 2$|^(apt|apartment|unit|suite)( number| or unit)?$|^apt suite$/, 'addressLine2'],
    [/^(city|town)$/, 'city'],
    [/^state( province)?$/, 'state'],
    [/^(zip|zip code|zipcode|postal code)$/, 'zip'],
    [/^county$/, 'county'],
    [/^(household size|family size|size of (your )?household|(number of |total )?(people|persons|members) in (your )?household|how many people ((live|are) )?in (your )?household( (?!.*\b(are|is|who|that|have|has|work\w*|employ\w*|over|under|aged?|between|older|younger|adults?|child(ren)?|kids?|seniors?|veterans?|disab\w*|students?|infants?|bab(y|ies)|\d+)\b).+)?|(total )?household members|(number of |how many )(family |household |family household |family or household )members)$/, 'householdSize'],
    [counted('adults'), 'householdAdults'],
    [counted('(children|kids)'), 'householdChildren'],
    [counted('(seniors|older adults)'), 'householdSeniors'],
    [counted('(adults|people|persons|individuals|members|household members)', AGE_BANDS.householdAdults), 'householdAdults'],
    [counted('(children|kids|people|persons|individuals|members|household members)', AGE_BANDS.householdChildren), 'householdChildren'],
    [counted('(seniors|older adults|adults|people|persons|individuals|members|household members)', AGE_BANDS.householdSeniors), 'householdSeniors'],
    [/^(is )?anyone in (your |the )?household a (military )?veteran$|^veteran( status)?$/, 'householdVeteran'],
    [/^(does )?anyone( in (your |the )?household)? (have|has) a disability$|^disability$/, 'householdDisability'],
    [new RegExp(`^${ANYONE} (age |aged )?(${AGE_BANDS.householdSeniors})( years?( old)?)?$`), 'anyoneSenior'],
    [new RegExp(`^${ANYONE} an? (resident of iowa|iowa resident)$`), 'iowaResident'],
    [new RegExp(`^${ANYONE}( currently)? pregnant$`), 'householdPregnant'],
    [new RegExp(`^${ANYONE}( currently)? (enrolled in|on|receiving|getting) medicare$`), 'householdMedicare'],
    [/^(are )?all (of )?(the )?(household members|members of (your |the )?household|people in (your |the )?household)( are)? (united states|u s|us) citizens$/, 'householdAllCitizens'],
    [/^(if not )?(do|does) (they|those members|those people) have (legal|valid) (immigration )?documents to (stay|live|be) in (the )?(united states|u s|us)$/, 'householdLegalStatus'],
    [/^do you want to find out if (you or your family|you|your family|anyone( in (your |the )?household)?) (can|could) get help paying for health (insurance|coverage)$/, 'wantsHealthCoverage'],
    // Iowa's long income and savings questions go on with what to include; their opening is specific enough.
    [/^how much (total )?money did all (of )?(the )?people in (your |the )?household (get|receive|earn) last month( .*)?$/, 'totalMonthlyIncome'],
    [/^how much (money )?does (the |your )?household have on hand( .*)?$|^(total )?money on hand$/, 'assetsOnHand'],
    [/^how much does (the |your )?household pay (for|in) medical (expenses|bills|costs) (monthly|each month|per month|a month)$|^monthly medical (expenses|bills|costs)$|^medical (expenses|bills|costs) (per|each|a) month$/, 'monthlyMedicalExpenses'],
    [/^(total )?(gross )?monthly (household )?income$|^(total )?household income per month$/, 'totalMonthlyIncome'],
    [/^(total )?(gross )?(annual|yearly) (household )?income$|^(total )?household income per year$/, 'annualIncome'],
    [/^(monthly )?(rent|mortgage|rent or mortgage)( payment| amount)?$/, 'monthlyRent'],
    [/^(monthly )?utilit(y|ies)( costs?| bills?)?$/, 'monthlyUtilities']
  ];
  const NAME_HINTS = Object.freeze({ fname: 'first name', firstname: 'first name', lname: 'last name', lastname: 'last name', dob: 'date of birth',
    zipcode: 'zip code', postalcode: 'postal code', hhsize: 'household size', tel: 'phone', telephone: 'phone', email: 'email', zip: 'zip', city: 'city', state: 'state' });
  const STATES = Object.freeze({ AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
    DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky',
    LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
    NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio',
    OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
    VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming' });
  const SKIP_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'image', 'reset', 'color', 'range']);
  const UNSAFE = /\b(password|passcode|pin|cvv|cvc|card number|credit card|debit card|expiration|expiry|security code|captcha|verification code|one time)\b/;
  const LEAD = /^(what is|whats|please enter|please provide|enter|provide|your|the)\s+/;

  const clean = value => String(value || '').replace(/\s+/g, ' ').trim().replace(/[\s*:]+$/, '').trim();
  // "#" reads as "number" ("# of adults", "Apt #").
  const normal = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[‘’']/g, '').replace(/#/g, ' number ').replace(/\*/g, ' ').replace(/[^a-z0-9+]+/g, ' ').trim();
  // A question number or letter the author added ("3.", "4)", "b. ") is not part of the question.
  const QUESTION_NUMBER = /^\s*(\d{1,3}\s*[.)]|[a-z][.)](?=\s))\s*/i;
  // An aside in parentheses ("(First and Last Name)") is dropped, unless it holds numbers
  // (age bands like "(0-5)") or points at someone other than the applicant ("(spouse)").
  const OTHER_PERSON = /\b(child|children|kid|spouse|partner|husband|wife|emergency|contact|pet|landlord|employer|other|previous|former|maiden|alternate|second|secondary|work|business)s?\b/i;
  const aside = (text, inner) => /\d/.test(inner) || OTHER_PERSON.test(inner) ? text : ' ';
  function question(value) {
    const words = String(value || '').replace(/([a-z])([A-Z][a-z])/g, '$1 $2').replace(QUESTION_NUMBER, '').replace(/\(([^()]*)\)/g, aside);
    let text = normal(words).replace(/ (required|optional)$/, '');
    for (let previous = ''; previous !== text;) { previous = text; text = text.replace(LEAD, ''); }
    return text;
  }
  // A guardian or parent may be the applicant, but saying so would be a guess: their boxes stay with the applicant.
  const OTHER_PERSON_ROLE = /\b(spouse|spouses|partner|husband|wife|helper|proxy|emergency contact|reference|landlord|other household member|guardian|guardians|parent|parents|conyuge|esposo|esposa|pareja|dependiente|ayudante|contacto de emergencia|referencia|propietario|arrendador|tutor legal)\b|\brepresentative\b|\brepresentante\b/;
  const MEMBER_DETAIL = /\b(family member|household member (number )?\d+|miembro de (la )?(familia|casa|hogar))\b/;
  // Someone other than the applicant when the question asks for their details: a child or a student.
  const CHILD_ROLE = /\b(child|children|son|daughter|student|students|hijo|hija|hijos|hijas|estudiante|estudiantes)\b/;
  const PERSON_DETAIL = /\b(name|nombre|birth|nacimiento|address|direccion|phone|telefono|email|relationship|school|escuela)\b/;
  const COMBINED_ADDRESS_QUESTION = /^(city (and )?state|city (and )?(zip|zip code|zipcode|postal code)|city (and )?state (and )?(zip|zip code|zipcode|postal code)|(complete|full) (physical |home |residential )?address( including (town|city|town city))?|ciudad (y )?estado|ciudad (y )?codigo postal|ciudad (y )?estado (y )?codigo postal|direccion completa)$/;
  const PERSON_NOT_AMOUNT = /^(who|que persona|quien) (pays?|paga)( |$)/;
  function otherPersonQuestion(value) {
    const text = normal(value);
    const representative = !(text.startsWith('household representative ') || text === 'household representative') && OTHER_PERSON_ROLE.test(text);
    return representative || MEMBER_DETAIL.test(text) || (CHILD_ROLE.test(text) && PERSON_DETAIL.test(text)) || text === 'household members' || /^household members (first|last|full|date|birth|name|phone|email|address|relation|relationship)\b/.test(text);
  }
  const blockedSuggestion = value => otherPersonQuestion(value) || COMBINED_ADDRESS_QUESTION.test(question(value)) || PERSON_NOT_AMOUNT.test(question(value));
  // A count of people by age: "# of people in your household 18 - 59 yrs old", "60 +", "60 and older",
  // "under 5", "ages 6 to 18", "0–5". The band is read whole or not at all.
  const BAND_QUESTION = new RegExp(`^((number of|how many|total) )?(people|persons|individuals|members|household members|family members|children|kids|adults|seniors|older adults)${IN_HOUSEHOLD} (ages? |aged )?(?<band>.+?)( (years?|yrs?)( old| of age)?)?${IN_HOUSEHOLD}$`);
  const BAND_FORMS = [
    [/^(?:between )?(\d{1,3}) (?:to |through |thru |and )?(\d{1,3})$/, match => [match[1], match[2]]],
    [/^(\d{1,3}) ?\+$/, match => [match[1], '']],
    [/^(\d{1,3})(?: years?| yrs?)? (?:and|or) (?:older|over|above|up)$/, match => [match[1], '']],
    [/^(?:under|below|younger than|less than) (?:age )?(\d{1,3})$/, match => ['0', String(Number(match[1]) - 1)]],
    [/^(\d{1,3})(?: years?| yrs?)? (?:and|or) (?:under|younger|below)$/, match => ['0', match[1]]]
  ];
  // The profile's own counts answer their exact bands; any other band is a band count.
  const SAVED_BANDS = Object.freeze({ 'householdCount:0-17': 'householdChildren', 'householdCount:18-64': 'householdAdults', 'householdCount:65+': 'householdSeniors' });
  function bandRule(asked) {
    const band = BAND_QUESTION.exec(asked)?.groups.band;
    for (const [form, bounds] of band ? BAND_FORMS : []) {
      const found = form.exec(band);
      if (!found) continue;
      const [low, high] = bounds(found).map(value => value === '' ? '' : String(Number(value)));
      // Numbers as written: "007" is not a band.
      if (found.slice(1).some(value => value && /^0\d/.test(value))) return null;
      const key = `householdCount:${low}${high === '' ? '+' : `-${high}`}`;
      return isBandKey(key) ? SAVED_BANDS[key] || key : null;
    }
    return null;
  }
  // A household member's own question, asked by name: the one student's name and grade.
  const MEMBER_RULES = [
    [/^(students? (full )?name (and )?(school )?grade( level)?|(full )?name (and )?(school )?grade( level)? of (the |your )?students?|name of (the |your )?students? (and )?(school )?grade( level)?)$/, 'studentNameGrade']
  ];
  const memberRuleFor = text => MEMBER_RULES.find(([pattern]) => pattern.test(question(text)))?.[1] || null;
  function ruleFor(text) {
    const asked = question(text);
    return RULES.find(([pattern]) => pattern.test(asked))?.[1] || bandRule(asked);
  }
  // Questions only the applicant answers: AI never suggests or picks an answer for consent,
  // signatures, attestations, agreements, terms, Social Security numbers, or secrets.
  // shared/laya-prompts.cjs keeps an identical copy for the desktop app.
  const UNSAFE_QUESTION = /^social security$|\b(consent\w*|sign|signs|signed|signing|signature\w*|initials|attest\w*|certif\w*|agree|agrees|agreed|agreement\w*|terms|acknowledg\w*|authoriz\w*|permission|perjury|i understand|i confirm|i have read|true and (correct|accurate|complete)|privacy|social security (number|no|num|card)|ss number|ssn|itin|password|passcode|pin|cvv|cvc|card number|credit card|debit card|security code|captcha|verification code|one time)\b/;
  const unsafeQuestion = field => [field?.label, ...(Array.isArray(field?.options) ? field.options : [])].some(text => UNSAFE_QUESTION.test(normal(text)));
  // The questions Laya, the desktop app's AI, may take, within the bridge's limits: a text box to match
  // to a saved field ('text') or a choice question to answer ('choice'). Never one only the applicant answers.
  const LAYA = Object.freeze({ text: Object.freeze(['text', 'textarea', 'number', 'date', 'email', 'tel']), choice: Object.freeze(['radio', 'select', 'checkbox']),
    label: 200, options: 30, option: 100 });
  const layaText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  function layaQuestion({ label, type, options }) {
    if (!layaText(label, LAYA.label) || !Array.isArray(options) || options.length > LAYA.options || options.some(option => !layaText(option, LAYA.option)) ||
      new Set(options).size !== options.length || unsafeQuestion({ label, options })) return '';
    if (LAYA.text.includes(type)) return 'text';
    return LAYA.choice.includes(type) && options.length ? 'choice' : '';
  }
  // Whether a guess (the AI step) may offer a key for a question. A birth date only goes to a
  // whole-date question about birth, never to "Date ordered", a month box, or a child's birthday.
  function canSuggest(key, field) {
    if (!GENERIC_KEYS.includes(key)) return false;
    if (blockedSuggestion(field?.label)) return false;
    if (key !== 'birthDate') return true;
    const text = question(field?.label);
    return /\b(birth|born|dob)/.test(text) && !/\b(month|day|year|time|hours?|minutes?)\b/.test(text) && !OTHER_PERSON.test(text);
  }

  // A label's own aria-hidden only hides it from screen readers (Jotform marks every choice
  // label that way), so a choice label is checked with `labelOnly`; an aria-hidden ancestor still hides it.
  function rendered(element, labelOnly = false) {
    const win = element.ownerDocument.defaultView;
    if (!win || !element.isConnected) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      const customChoice = node === element && ['radio', 'checkbox'].includes(element.type) && Array.from(element.labels || []).some(label => rendered(label, true));
      const ariaHidden = node.getAttribute('aria-hidden') === 'true' && !(labelOnly && node === element);
      if (node.hidden || node.hasAttribute('inert') || ariaHidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || (style.opacity === '0' && !customChoice)) return false;
    }
    const rect = element.getBoundingClientRect();
    return Boolean(element.getClientRects().length && rect.width > 0 && rect.height > 0);
  }
  function textWithoutControls(node) {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('input, select, textarea, button, script, style').forEach(control => control.remove());
    return clean(copy.textContent);
  }
  function idsText(doc, ids) { return clean(String(ids || '').split(/\s+/).filter(Boolean).map(id => doc.getElementById(id)?.textContent || '').join(' ')); }
  // Short visible text just before a control or group, for forms without <label>.
  function precedingText(node) {
    for (let ancestor = node, depth = 0; ancestor && depth < 3; ancestor = ancestor.parentElement, depth++) {
      for (let sibling = ancestor.previousElementSibling, steps = 0; sibling && steps < 2; sibling = sibling.previousElementSibling, steps++) {
        if (sibling.matches('input, select, textarea, button') || sibling.querySelector('input, select, textarea')) break;
        const text = textWithoutControls(sibling);
        if (text && text.length <= 150) return text;
      }
    }
    return '';
  }
  // The question a control sits in: the nearest labelled group or form-builder question item.
  const QUESTION_BOX = '[role="listitem"], [role="radiogroup"], [role="group"], fieldset';
  function boxHeading(box, doc) {
    const legend = box.tagName === 'FIELDSET' ? box.querySelector('legend') : null;
    return idsText(doc, box.getAttribute('aria-labelledby')) || clean(box.getAttribute('aria-label')) || (legend ? textWithoutControls(legend) : '') ||
      clean(box.querySelector('[role="heading"]')?.textContent);
  }
  function enclosingQuestion(node, doc) {
    for (let box = node.parentElement?.closest(QUESTION_BOX); box; box = box.parentElement?.closest(QUESTION_BOX)) {
      const text = boxHeading(box, doc);
      if (text) return { box, text };
    }
    return null;
  }
  // "Date", "Month", "Hour"… name a part of a question, not the question itself.
  const DATE_PART = /^(date|month|day|year|time|hours?|minutes?)$/;
  function labelsFor(element, doc) {
    const candidates = [idsText(doc, element.getAttribute('aria-labelledby')), clean(element.getAttribute('aria-label')),
      ...Array.from(element.labels || [], textWithoutControls), clean(element.getAttribute('placeholder'))];
    const present = candidates.filter(Boolean);
    const labels = present.length ? present : [precedingText(element)].filter(Boolean);
    return labels.map(text => {
      const asked = enclosingQuestion(element, doc)?.text;
      if (asked && normal(asked) !== normal(text) && otherPersonQuestion(asked)) return `${asked}: ${text}`;
      if (!DATE_PART.test(normal(text))) return text;
      return asked && normal(asked) !== normal(text) ? `${asked}: ${text}` : text;
    });
  }
  // Form builders such as Google Forms draw choices as div[role=radio|checkbox|listbox], not native controls.
  const ARIA_CONTROLS = '[role="radio"], [role="checkbox"], [role="listbox"]';
  const ARIA_TYPES = Object.freeze({ ariaRadio: 'radio', ariaCheckbox: 'checkbox', ariaListbox: 'listbox' });
  const ariaUsable = element => !element.matches('input, select, textarea') && element.getAttribute('aria-disabled') !== 'true' && rendered(element);
  // Radios group by their radiogroup; checkboxes by the question they sit in; a listbox stands alone.
  function ariaGroup(element, doc) {
    const role = element.getAttribute('role');
    if (role === 'listbox') return { kind: 'ariaListbox', group: element };
    if (role === 'radio') { const group = element.closest('[role="radiogroup"]'); return group ? { kind: 'ariaRadio', group } : null; }
    return { kind: 'ariaCheckbox', group: enclosingQuestion(element, doc)?.box || element };
  }
  function ariaLabels(entry, doc) {
    if (entry.group === entry.elements[0] && entry.kind === 'ariaCheckbox') return [ariaOptionText(entry.group)].filter(Boolean);
    return [boxHeading(entry.group, doc) || enclosingQuestion(entry.group, doc)?.text || precedingText(entry.group)].filter(Boolean);
  }
  function ariaRequired(entry, doc) {
    if ([entry.group, ...entry.elements].some(element => element.getAttribute('aria-required') === 'true')) return true;
    const box = enclosingQuestion(entry.group, doc)?.box || entry.group;
    return Boolean(box.querySelector('[aria-label*="required" i]')) || /\*\s*$/.test(box.querySelector('[role="heading"], legend')?.textContent || '');
  }
  const ariaOptionValue = option => option.hasAttribute('data-value') ? option.getAttribute('data-value') : clean(option.textContent);
  const ariaOptionText = option => clean(option.getAttribute('aria-label') || option.getAttribute('data-value') || option.getAttribute('data-answer-value') || option.textContent);
  const listboxOptions = listbox => Array.from(listbox.querySelectorAll('[role="option"]')).filter(option => ariaOptionValue(option));
  function groupQuestion(elements, doc) {
    const first = elements[0];
    const container = first.closest('fieldset, [role="radiogroup"], [role="group"]');
    const candidates = [];
    if (container) {
      candidates.push(textWithoutControls(container.querySelector('legend') || doc.createElement('i')), idsText(doc, container.getAttribute('aria-labelledby')), clean(container.getAttribute('aria-label')));
      if (!candidates.some(Boolean)) candidates.push(precedingText(container));
    } else candidates.push(precedingText(first.closest('label') || first));
    return candidates.filter(Boolean);
  }
  function eligible(element) {
    const type = (element.type || '').toLowerCase();
    const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
    if (!element.matches('input, select, textarea') || SKIP_TYPES.has(type) || /(^|\s)cc-|one-time-code|password/.test(autocomplete)) return false;
    if (element.disabled || element.readOnly || !rendered(element)) return false;
    const identity = normal(`${element.name || ''} ${element.id || ''} ${Array.from(element.labels || [], label => label.textContent).join(' ')} ${element.getAttribute('aria-label') || ''}`);
    return !UNSAFE.test(identity);
  }
  const optionText = element => clean(Array.from(element.labels || [], textWithoutControls).join(' ') || element.getAttribute('aria-label') || element.value);
  function answered(entry) {
    if (entry.kind === 'ariaRadio' || entry.kind === 'ariaCheckbox') return [...entry.elements, ...entry.group.querySelectorAll('[aria-checked="true"]')].some(element => element.getAttribute('aria-checked') === 'true');
    if (entry.kind === 'ariaListbox') return listboxOptions(entry.group).some(option => option.getAttribute('aria-selected') === 'true');
    return entry.kind === 'radio' || entry.kind === 'checkbox' ? entry.elements.some(element => element.checked)
      : entry.kind === 'select' ? Boolean(entry.elements[0].value) : Boolean(String(entry.elements[0].value || '').trim());
  }
  function kindOf(element) {
    if (element.tagName === 'SELECT') return 'select';
    if (element.tagName === 'TEXTAREA') return 'textarea';
    return element.type === 'radio' ? 'radio' : element.type === 'checkbox' ? 'checkbox' : 'input';
  }
  function optionsOf(entry) {
    // A select's empty-value entry is a placeholder ("Choose one"), not an answer.
    if (entry.kind === 'select') return Array.from(entry.elements[0].options).filter(option => option.value).map(option => clean(option.textContent) || option.value);
    if (entry.kind === 'radio' || (entry.kind === 'checkbox' && entry.elements.length > 1)) return entry.elements.map(optionText);
    if (entry.kind === 'ariaRadio' || (entry.kind === 'ariaCheckbox' && entry.elements.length > 1)) return entry.elements.map(ariaOptionText);
    if (entry.kind === 'ariaListbox') return listboxOptions(entry.group).map(ariaOptionText);
    return [];
  }
  const isYesNo = options => options.some(option => /^yes\b/.test(normal(option))) && options.some(option => /^no\b/.test(normal(option)));
  // A count choice: "3", "4+", "8 or More", "Two", "One (Myself)", "Five or more".
  const NUMBER_WORDS = Object.freeze({ zero: 0, none: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 });
  function countOf(option) {
    const found = /^(\d+|[a-z]+)( ?\+| or more)?$/.exec(normal(String(option).replace(/\([^()]*\)/g, ' ')));
    const number = found && (/^\d+$/.test(found[1]) ? Number(found[1]) : NUMBER_WORDS[found[1]]);
    return typeof number === 'number' ? { number, orMore: Boolean(found[2]) } : null;
  }
  const isNumeric = options => options.length > 0 && options.every(option => countOf(option));
  const ageRange = option => /^(\d+) (\d+)( yrs?| years?)?$/.exec(normal(option)) || /^(\d+)(\+| and older| or older)( yrs?| years?)?$/.exec(normal(option));
  // A key is only placed on a control that can hold its kind of answer. Div checkboxes and
  // listboxes are only ever left for the applicant.
  const answerKind = key => isBandKey(key) ? 'count' : KIND[key] || 'text';
  function compatible(key, entry) {
    if (entry.kind === 'ariaCheckbox' || entry.kind === 'ariaListbox') return false;
    const kind = answerKind(key);
    const type = (entry.elements[0].type || 'text').toLowerCase();
    const options = optionsOf(entry);
    const choice = entry.kind === 'radio' || entry.kind === 'ariaRadio';
    if (kind === 'yesno') return (choice || entry.kind === 'select') ? isYesNo(options) : entry.kind === 'checkbox' && entry.elements.length === 1;
    if (kind === 'ageRange') return (choice || entry.kind === 'select') && options.some(ageRange);
    if (kind === 'count') return (entry.kind === 'input' && ['number', 'text', 'tel', ''].includes(type)) || ((entry.kind === 'select' || choice) && isNumeric(options.filter(option => normal(option))));
    if (kind === 'state') return entry.kind === 'select' || (entry.kind === 'input' && type === 'text');
    if (kind === 'date') return entry.kind === 'input' && ['date', 'text', ''].includes(type);
    if (kind === 'email') return entry.kind === 'input' && ['email', 'text'].includes(type);
    if (kind === 'tel') return entry.kind === 'input' && ['tel', 'text', 'number'].includes(type);
    if (kind === 'money') return entry.kind === 'input' && ['number', 'text', ''].includes(type);
    return entry.kind === 'textarea' || (entry.kind === 'input' && ['text', 'search', ''].includes(type));
  }
  function match(entry) {
    const element = entry.elements[0];
    // A member's own question takes that member's answer; it names another person, so nothing of the applicant's.
    for (const text of entry.labels) {
      const key = memberRuleFor(text);
      if (key && compatible(key, entry)) return { key, confidence: 'high' };
    }
    if (entry.labels.some(otherPersonQuestion)) return { key: null, confidence: null };
    for (const text of entry.labels) {
      const key = ruleFor(text);
      if (['cityState', 'cityZip', 'cityStateZip', 'fullAddress'].includes(key) && compatible(key, entry)) return { key, confidence: 'high' };
    }
    const tokens = String(element.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).reverse();
    const auto = tokens.map(token => AUTOCOMPLETE[token]).find(Boolean);
    if (auto && compatible(auto, entry)) return { key: auto, confidence: 'high' };
    for (const text of entry.labels) {
      const key = ruleFor(text);
      if (key && compatible(key, entry)) return { key, confidence: 'high' };
    }
    if (ARIA_TYPES[entry.kind]) return { key: null, confidence: null };
    const hint = normal(`${element.name || ''}`.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\[[^\]]*\]$/, '')) || normal(element.id || '');
    const key = ruleFor(NAME_HINTS[hint.replace(/ /g, '')] || hint);
    if (key && compatible(key, entry)) return { key, confidence: entry.labels.length ? 'medium' : 'high' };
    return { key: null, confidence: null };
  }

  let current = null;
  let sequence = 0;
  // The question list's own ids, kept apart from the plan so listing never invalidates a fill.
  let listed = null;
  let listings = 0;
  // Every eligible question on the page with its labels, answered or not.
  function questionsOn(doc) {
    const entries = [];
    const groups = new Map();
    for (const element of doc.querySelectorAll(`input, select, textarea, ${ARIA_CONTROLS}`)) {
      if (!element.matches('input, select, textarea')) {
        const choice = ariaUsable(element) && ariaGroup(element, doc);
        if (!choice) continue;
        if (groups.has(choice.group)) { groups.get(choice.group).elements.push(element); continue; }
        const entry = { kind: choice.kind, group: choice.group, elements: [element] };
        groups.set(choice.group, entry); entries.push(entry);
        continue;
      }
      if (!eligible(element)) continue;
      const kind = kindOf(element);
      if ((kind === 'radio' || kind === 'checkbox') && element.name) {
        const groupKey = `${kind}|${element.form ? Array.from(doc.forms).indexOf(element.form) : -1}|${element.name}`;
        if (groups.has(groupKey)) { groups.get(groupKey).elements.push(element); continue; }
        const entry = { kind, elements: [element] };
        groups.set(groupKey, entry); entries.push(entry);
      } else entries.push({ kind, elements: [element] });
    }
    for (const entry of entries) {
      const grouped = entry.kind === 'radio' || (entry.kind === 'checkbox' && entry.elements.length > 1);
      entry.labels = ARIA_TYPES[entry.kind] ? ariaLabels(entry, doc) : grouped ? groupQuestion(entry.elements, doc) : labelsFor(entry.elements[0], doc);
      if (ARIA_TYPES[entry.kind]) entry.required = ariaRequired(entry, doc);
    }
    return entries;
  }
  function scan(doc) {
    // A div question is only safe to leave to the rules when nothing on it asks for secrets.
    return questionsOn(doc).filter(entry => !answered(entry) && !(ARIA_TYPES[entry.kind] && UNSAFE.test(normal(entry.labels.join(' ')))));
  }

  // The page's questions for the applicant to read in their language: ids and labels only,
  // never answers. Each id can be shown with focusField.
  function questions(doc) {
    const sequence = ++listings;
    const map = new Map();
    const items = [];
    for (const entry of questionsOn(doc)) {
      if (!entry.labels[0]) continue;
      const id = `sq-${sequence}-${items.length}`;
      map.set(id, entry);
      items.push({ id, label: entry.labels[0] });
    }
    listed = { doc, map };
    return items;
  }

  // A question as the worker sees it: its label, type, choices, and whether it must be answered.
  function fieldOf(entry) {
    const first = entry.elements[0];
    return { label: entry.labels[0] || '', type: entry.kind === 'input' ? (first.type || 'text') : ARIA_TYPES[entry.kind] || entry.kind, options: optionsOf(entry),
      required: entry.required ?? (entry.elements.some(element => element.required || element.getAttribute('aria-required') === 'true') || /\*\s*$/.test(entry.labels.join(' '))) };
  }
  function plan(doc) {
    const token = `plan-${Date.now().toString(36)}-${++sequence}`;
    const map = new Map();
    const matched = [], unmatched = [];
    scan(doc).forEach((entry, index) => {
      const id = `sh-${sequence}-${index}`;
      map.set(id, entry);
      const result = match(entry);
      if (result.confidence === 'high') { matched.push({ id, key: result.key, confidence: 'high' }); return; }
      unmatched.push({ id, ...fieldOf(entry) });
    });
    current = { token, doc, map };
    return { token, matched, unmatched };
  }

  // Questions that never make SecondHand's card show: search boxes, verification codes, and the user
  // name, email, or phone box beside a password. The rules still read them like any other question.
  const SEARCH = /^(search|find)\b/;
  const SEARCH_NAMES = Object.freeze(['q', 's', 'query', 'search', 'keyword', 'keywords']);
  const CODE = /\b(otp|2fa|mfa|one time|verification|verify|authentication|confirmation|access) code\b|\b\d+ digit code\b|\bcode (that )?(we )?(sent|texted|emailed)\b|^(enter )?(the |your )?code$/;
  const SIGN_IN = /\b(user ?name|user ?id|login|log ?in|sign ?in|account|e ?mail|phone|mobile)\b/;
  function besideForm(entry, doc) {
    const element = entry.elements[0];
    const words = normal(`${entry.labels.join(' ')} ${element.getAttribute('placeholder') || ''}`);
    if (element.type === 'search' || element.matches('[role="searchbox"]') || element.closest('search, [role="search"]') || SEARCH.test(words) ||
      SEARCH_NAMES.includes(normal(element.getAttribute('name')))) return true;
    if (CODE.test(words)) return true;
    const scope = element.form || element.closest('form') || doc;
    const password = Array.from(scope.querySelectorAll('input[type="password"]')).some(box => rendered(box));
    return password && SIGN_IN.test(`${words} ${normal(`${element.getAttribute('name') || ''} ${element.id || ''} ${element.getAttribute('autocomplete') || ''}`)}`);
  }
  // Whether the page asks something SecondHand can help with, so its card shows: a question the rules
  // match to a saved answer, or one Laya could take, answered or not. It only reads the page: the plan
  // the worker holds stays valid.
  function offers(doc) {
    return questionsOn(doc).some(entry => !(ARIA_TYPES[entry.kind] && UNSAFE.test(normal(entry.labels.join(' ')))) && !besideForm(entry, doc) &&
      (match(entry).confidence === 'high' || layaQuestion(fieldOf(entry)) !== ''));
  }

  function requestKeys(keys) {
    return [...new Set((Array.isArray(keys) ? keys : []).flatMap(key => SOURCES[key] || [key]))].filter(key => PROFILE_KEYS.includes(key) || ruleOnlyKey(key));
  }
  const cents = value => /^\d{1,8}(\.\d{1,2})?$/.test(String(value || '')) ? Math.round(Number(value) * 100) : null;
  const dollars = amount => amount % 100 ? (amount / 100).toFixed(2) : String(amount / 100);
  function deriveValues(values) {
    const result = { ...(values || {}) };
    if (result.firstName && result.lastName) result.fullName = `${result.firstName} ${result.lastName}`;
    if (result.city && result.state) result.cityState = `${result.city}, ${result.state}`; else delete result.cityState;
    if (result.city && result.zip) result.cityZip = `${result.city}, ${result.zip}`; else delete result.cityZip;
    if (result.city && result.state && result.zip) result.cityStateZip = `${result.city}, ${result.state} ${result.zip}`; else delete result.cityStateZip;
    if (result.addressLine1 && result.city && result.state && result.zip) result.fullAddress = [result.addressLine1, result.addressLine2, `${result.city}, ${result.state} ${result.zip}`].filter(Boolean).join(', ');
    else delete result.fullAddress;
    const phone = values?.mobilePhone || values?.homePhone || values?.phone;
    if (phone) result.phone = phone; else delete result.phone;
    const birth = /^(\d{4})-(\d{2})-(\d{2})$/.exec(values?.birthDate || '');
    if (birth) {
      const today = new Date(), year = Number(birth[1]), month = Number(birth[2]), day = Number(birth[3]);
      result.ageRange = String(today.getFullYear() - year - (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day) ? 1 : 0));
    } else delete result.ageRange;
    const earned = cents(values?.monthlyEarnedIncome), other = cents(values?.monthlyOtherIncome);
    // A total is only offered when both parts are known; a partial sum would understate income.
    if (earned !== null && other !== null) { result.totalMonthlyIncome = dollars(earned + other); result.annualIncome = dollars((earned + other) * 12); }
    // Yes/no answers derived from other saved answers, offered only when those settle them.
    delete result.anyoneSenior; delete result.iowaResident; delete result.wantsHealthCoverage;
    if (/^\d+$/.test(String(values?.householdSeniors ?? ''))) result.anyoneSenior = Number(values.householdSeniors) > 0 ? 'yes' : 'no';
    // A home state of Iowa suggests residency; any other state settles nothing.
    if (String(values?.state || '').trim().toUpperCase() === 'IA' || normal(values?.state) === 'iowa') result.iowaResident = 'yes';
    if (['yes', 'no'].includes(values?.programMedicaid)) result.wantsHealthCoverage = values.programMedicaid;
    return result;
  }

  function setValue(element, value) {
    const win = element.ownerDocument.defaultView;
    const prototype = element.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new win.Event('input', { bubbles: true }));
    element.dispatchEvent(new win.Event('change', { bubbles: true }));
    return element.value === value;
  }
  function chooseOption(options, key, value) {
    const wanted = normal(value);
    if (answerKind(key) === 'yesno') return options.findIndex(option => new RegExp(`^${wanted}\\b`).test(normal(option)));
    if (answerKind(key) === 'ageRange') return options.findIndex(option => { const range = ageRange(option); return range && Number(value) >= Number(range[1]) && (range[2] === '+' || range[2] === ' and older' || range[2] === ' or older' || Number(value) <= Number(range[2])); });
    if (key === 'state') return options.findIndex(option => [wanted, normal(STATES[String(value).toUpperCase()])].includes(normal(option)));
    if (answerKind(key) === 'count') {
      if (!/^\d+$/.test(String(value))) return -1;
      const counts = options.map(countOf);
      const exact = counts.findIndex(count => count && !count.orMore && count.number === Number(value));
      if (exact >= 0) return exact;
      // Otherwise the highest "N or more" choice that still covers the count.
      let best = -1;
      counts.forEach((count, index) => { if (count?.orMore && count.number <= Number(value) && (best < 0 || count.number > counts[best].number)) best = index; });
      return best;
    }
    return options.findIndex(option => normal(option) === wanted);
  }
  function formatted(key, value, element) {
    const text = String(value);
    if (key === 'birthDate') {
      const [year, month, day] = text.split('-');
      return element.type === 'date' ? text : `${month}/${day}/${year}`;
    }
    if (key === 'phone') {
      const digits = text.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
      if (element.type === 'number') return digits;
      return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : text;
    }
    return text;
  }
  function fillEntry(entry, key, value) {
    const first = entry.elements[0];
    if (entry.kind === 'input' || entry.kind === 'textarea') {
      const text = formatted(key, value, first);
      if (first.maxLength > 0 && text.length > first.maxLength) return false;
      return setValue(first, text);
    }
    if (entry.kind === 'select') {
      const options = Array.from(first.options);
      // A state select may use codes ("IA") or names ("Iowa") as values.
      let index = key === 'state' ? options.findIndex(option => normal(option.value) === normal(value)) : -1;
      if (index < 0) index = chooseOption(options.map(option => clean(option.textContent) || option.value), key, value);
      const target = options[index];
      return Boolean(target && target.value) && setValue(first, target.value);
    }
    if (entry.kind === 'radio') {
      const index = chooseOption(entry.elements.map(optionText), key, value);
      if (index < 0) return false;
      entry.elements[index].click();
      return entry.elements[index].checked;
    }
    if (entry.kind === 'ariaRadio') {
      // The page's own script registers the click; only a choice it marked as checked counts.
      // Google Forms marks it in its next task, so an unmarked choice waits for settle().
      const index = chooseOption(entry.elements.map(ariaOptionText), key, value);
      if (index < 0) return false;
      const option = entry.elements[index];
      option.click();
      return option.getAttribute('aria-checked') === 'true' || { pending: option };
    }
    if (entry.kind === 'checkbox' && entry.elements.length === 1 && answerKind(key) === 'yesno') {
      if (value !== 'yes') return false;
      first.click();
      return first.checked;
    }
    return false;
  }
  // An answer Laya picked from the saved profile (#42): the option with exactly this text, and
  // only where it is the only option with that text. Only ever picks or checks; never unchecks.
  function fillOption(entry, option) {
    const options = optionsOf(entry);
    const index = options.indexOf(option);
    if (index < 0 || options.lastIndexOf(option) !== index) return false;
    const first = entry.elements[0];
    if (entry.kind === 'select') {
      const target = Array.from(first.options).filter(item => item.value)[index];
      return Boolean(target) && setValue(first, target.value);
    }
    if (entry.kind === 'radio' || (entry.kind === 'checkbox' && entry.elements.length > 1)) {
      const choice = entry.elements[index];
      if (choice.checked) return false;
      choice.click();
      return choice.checked;
    }
    if (entry.kind === 'ariaRadio') {
      const choice = entry.elements[index];
      choice.click();
      return choice.getAttribute('aria-checked') === 'true' || { pending: choice };
    }
    return false;
  }
  function ensureStyle(doc) {
    if (doc.getElementById('secondhand-filled-style')) return;
    const style = doc.createElement('style');
    style.id = 'secondhand-filled-style';
    style.textContent = '[data-secondhand-filled="rule"]{outline:2px solid #5f9b62!important;outline-offset:1px!important}[data-secondhand-filled="guess"]{outline:2px dashed #d99a2b!important;outline-offset:1px!important}' +
      '[data-secondhand-attention]{outline:3px solid #d99a2b!important;outline-offset:3px!important;box-shadow:0 0 0 7px #d99a2b40!important}';
    (doc.head || doc.documentElement).append(style);
  }
  function rejectedByPage(entry) {
    const container = entry.elements[0].closest('.form-line');
    return entry.elements.some(element => element.getAttribute('aria-invalid') === 'true') || container?.classList.contains('form-line-error') ||
      Boolean(container && Array.from(container.querySelectorAll('[role="alert"]')).some(rendered));
  }
  function mark(doc, entry, guess) {
    ensureStyle(doc);
    entry.elements.forEach(element => element.setAttribute('data-secondhand-filled', guess ? 'guess' : 'rule'));
  }
  function fillFields(doc, token, assignments, values) {
    const ids = (Array.isArray(assignments) ? assignments : []).map(item => item?.id);
    if (!current || current.token !== token || current.doc !== doc) return { ok: false, filled: [], skipped: ids, rejected: [], pending: [] };
    const filled = [], skipped = [], rejected = [], pending = [];
    current.pending = new Map();
    for (const assignment of assignments) {
      const entry = current.map.get(assignment?.id);
      const key = assignment?.key;
      const value = values?.[key];
      const usable = entry && !answered(entry) && entry.elements.every(element => element.isConnected && (ARIA_TYPES[entry.kind] ? ariaUsable(element) : eligible(element)));
      // An option Laya picked from the saved profile is always a guess, and never for a question only the applicant answers.
      const option = assignment?.option;
      const answering = typeof option === 'string' && key === undefined;
      // A key the rules did not choose for this question is a guess and must be one a guess may offer.
      const allowed = entry && (match(entry).key === key || canSuggest(key, { label: entry.labels[0] || '' }));
      const placed = !usable ? false
        : answering ? !unsafeQuestion({ label: entry.labels.join(' '), options: optionsOf(entry) }) && fillOption(entry, option)
        : option === undefined && (GENERIC_KEYS.includes(key) || COMPOSITE_KEYS.includes(key) || ruleOnlyKey(key)) && allowed && typeof value === 'string' && value && compatible(key, entry) && fillEntry(entry, key, value);
      if (!placed) { skipped.push(assignment?.id); continue; }
      const guess = answering || assignment.guessed || GUESS_KEYS.includes(key);
      if (placed.pending) { current.pending.set(assignment.id, { option: placed.pending, entry, guess }); pending.push(assignment.id); continue; }
      entry.elements[0].dispatchEvent(new entry.elements[0].ownerDocument.defaultView.Event('blur'));
      if (rejectedByPage(entry)) {
        if (entry.kind === 'input' || entry.kind === 'textarea' || entry.kind === 'select') setValue(entry.elements[0], '');
        rejected.push(assignment.id); continue;
      }
      mark(doc, entry, guess);
      filled.push(assignment.id);
    }
    return { ok: true, filled, skipped, rejected, pending };
  }
  // Waits for the choices fillFields left pending to show as checked. One the page never
  // checks (or a stale plan's) is reported as skipped; only confirmed choices count as filled.
  // A document without a window was left behind by a page change: the wait stops there, and
  // the fill is reported as interrupted, with nothing on it confirmed.
  async function settle(doc, token, result, { timeoutMs = 500 } = {}) {
    if (!result?.pending?.length) return result;
    const live = current && current.token === token && current.doc === doc ? current.pending : new Map();
    const checked = id => live.get(id)?.option.getAttribute('aria-checked') === 'true';
    const started = Date.now();
    while (doc.defaultView && !result.pending.every(checked) && Date.now() - started < timeoutMs) await new Promise(resolve => doc.defaultView.setTimeout(resolve, 10));
    if (!doc.defaultView) {
      for (const id of result.pending) live.delete(id);
      return { ...result, ok: false, pageChanged: true, filled: [...result.filled], skipped: [...result.skipped, ...result.pending], rejected: [...result.rejected], pending: [] };
    }
    const settled = { ...result, filled: [...result.filled], skipped: [...result.skipped], rejected: [...result.rejected], pending: [] };
    for (const id of result.pending) {
      const item = live.get(id);
      if (!checked(id)) settled.skipped.push(id);
      else if (rejectedByPage(item.entry)) settled.rejected.push(id);
      else { mark(doc, item.entry, item.guess); settled.filled.push(id); }
      live.delete(id);
    }
    return settled;
  }
  // What to show for a question: its whole card or fieldset when that holds only this
  // question's controls, otherwise the control (or choice group) itself.
  function attentionTargets(entry, doc) {
    const box = enclosingQuestion(entry.group || entry.elements[0], doc)?.box;
    const own = new Set(entry.elements);
    if (box && Array.from(box.querySelectorAll(`input:not([type="hidden"]), select, textarea, ${ARIA_CONTROLS}`)).every(control => own.has(control))) return [box];
    return entry.group ? [entry.group] : entry.elements;
  }
  let clearAttention = () => {};
  // Scrolls a question into view and highlights it. Keyboard focus is never moved: focusing
  // and then leaving an empty field makes sites such as Google Forms flag it as required.
  function focusField(doc, id) {
    const entry = (current?.doc === doc ? current.map.get(id) : null) || (listed?.doc === doc ? listed.map.get(id) : null);
    const element = entry?.elements[0];
    if (!element || !element.isConnected || !rendered(element)) return false;
    clearAttention();
    const targets = attentionTargets(entry, doc);
    ensureStyle(doc);
    const clear = () => {
      for (const target of targets) { target.removeAttribute('data-secondhand-attention'); target.removeEventListener('focusin', clear); }
      if (clearAttention === clear) clearAttention = () => {};
    };
    for (const target of targets) { target.setAttribute('data-secondhand-attention', ''); target.addEventListener('focusin', clear); }
    clearAttention = clear;
    if (typeof targets[0].scrollIntoView === 'function') targets[0].scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  }
  const elementFor = id => current?.map.get(id)?.elements[0] || null;

  const api = Object.freeze({ GENERIC_KEYS, PROFILE_KEYS, GUESS_KEYS, MEMBER_KEYS, UNSAFE_QUESTION, OTHER_PERSON_ROLE, MEMBER_DETAIL, CHILD_ROLE, PERSON_DETAIL,
    COMBINED_ADDRESS_QUESTION, PERSON_NOT_AMOUNT, blockedSuggestion, isBandKey, plan, offers, questions, requestKeys, deriveValues, fillFields, settle, focusField, elementFor,
    canSuggest, unsafeQuestion, layaQuestion });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandGeneric = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

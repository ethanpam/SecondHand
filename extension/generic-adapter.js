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
  // #184: a yes or no about the household getting a benefit now, for each benefit the saved list can hold (deriveValues).
  const BENEFIT_KEYS = Object.freeze({ snap: 'receivesSnap', wic: 'receivesWic', 'cash-assistance': 'receivesCashAssistance', medicaid: 'receivesMedicaid', ssi: 'receivesSsi',
    housing: 'receivesHousingAssistance', 'school-meals': 'receivesSchoolMeals' });
  // Answers chosen from lists, and the yes or no about each benefit worked out from one. Only the rules place them.
  const CHOICE_KEYS = Object.freeze(['studentLevel', 'incomeSources', 'currentBenefits', 'helpWanted', ...Object.values(BENEFIT_KEYS)]);
  const SOURCES = Object.freeze({ fullName: ['firstName', 'lastName'], phone: ['mobilePhone', 'homePhone', 'phone'],
    cityState: ['city', 'state'], cityZip: ['city', 'zip'], cityStateZip: ['city', 'state', 'zip'], fullAddress: ['addressLine1', 'addressLine2', 'city', 'state', 'zip'],
    ageRange: ['birthDate'], totalMonthlyIncome: ['monthlyEarnedIncome', 'monthlyOtherIncome'], annualIncome: ['monthlyEarnedIncome', 'monthlyOtherIncome'],
    anyoneSenior: ['householdSeniors'], iowaResident: ['state'], wantsHealthCoverage: ['programMedicaid'],
    ...Object.fromEntries(Object.values(BENEFIT_KEYS).map(key => [key, ['currentBenefits']])) });
  const GENERIC_KEYS = Object.freeze(['firstName', 'middleName', 'lastName', 'fullName', 'suffix', 'birthDate', 'ssn', 'email', 'phone',
    'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county', 'ageRange', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors',
    'householdVeteran', 'householdDisability', 'totalMonthlyIncome', 'annualIncome', 'monthlyRent', 'monthlyUtilities', 'assetsOnHand',
    'monthlyMedicalExpenses', 'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare', 'anyoneSenior', 'iowaResident',
    'wantsHealthCoverage']);
  // Saved fields an answer typed on a page may be saved to (Save to My information): the profile's own
  // fields, never the Social Security number. shared/schema.cjs SAVE_FIELDS is the desktop's identical list.
  const SAVE_KEYS = Object.freeze(PROFILE_KEYS.filter(key => key !== 'ssn'));
  const COMPOSITE_KEYS = Object.freeze(['cityState', 'cityZip', 'cityStateZip', 'fullAddress']);
  // Answers about a household member, worked out by the desktop from the household list. Only the
  // rules place them, and only in a box that asks for that member: never a guess, never an applicant box.
  const MEMBER_KEYS = Object.freeze(['studentNameGrade']);
  // Today's date (#258), which the desktop gives from its one "today", as it works out ages (todayDate in shared/schema.cjs).
  // Only the rules place it, and only in a box that asks for the date of this visit, order or request (todayAsked).
  const TODAY_KEY = 'todayDate';
  // These are explicit saved Iowa answers, not general-site fields or model guesses. The question
  // must state its scope and match a whole phrase. Person/amount/source detail rows stay manual.
  const IOWA_RULES = Object.freeze([
    [/^are you an iowa resident$/, 'applicantIowaResident', 'applicant'],
    [/^were you born in (the )?(united states|u s|us)$/, 'bornInUs', 'applicant'],
    [/^are you a naturalized (united states|u s|us) citizen$/, 'naturalizedCitizen', 'applicant'],
    [/^do you need an interpreter$/, 'needsInterpreter', 'applicant'],
    [/^do you (purchase|buy) and prepare (food|meals) with (this|your) household$/, 'eatsWithHousehold', 'applicant'],
    [/^are you pregnant$/, 'pregnant', 'applicant'],
    [/^are you a migrant or seasonal farmworker$/, 'migrantSeasonalFarmworker', 'applicant'],
    [/^does anyone in (your|the) household (attend|go to) school or college$/, 'householdInSchool', 'household'],
    [/^is anyone in (your|the) household on strike$/, 'householdOnStrike', 'household'],
    [/^does anyone in (your|the) household work expect to work or (is |are )?(self employed|selfemployed)$/, 'householdWorking', 'household'],
    [/^has anyone in (your|the) household ended a job in the (last|past) 30 days$/, 'householdJobEnded30Days', 'household'],
    [/^does (your|the) household receive (money )?from friends or relatives$/, 'incomeFriendsRelatives', 'household'],
    [/^does (your|the) household receive educational grants or loans$/, 'incomeEducationGrantsLoans', 'household'],
    [/^does (your|the) household pay (for )?dependent care( expenses)?$/, 'paysDependentCare', 'household'],
    [/^does (your|the) household pay housing expenses$/, 'paysHousing', 'household'],
    [/^does (your|the) household live in low rent or subsidized housing$/, 'lowRentHousing', 'household'],
    [/^does (your|the) household pay child support$/, 'paysChildSupport', 'household'],
    [/^does (your|the) household pay (for )?utilities$/, 'paysUtilities', 'household'],
    [/^has (your|the) household received energy assistance in the (past|last) year$/, 'receivedEnergyAssistance', 'household'],
    [/^does (your|the) household pay medical expenses$/, 'paysMedical', 'household'],
    [/^does (your|the) household pay medicare expenses$/, 'paysMedicare', 'household'],
    [/^does (your|the) household own real property$/, 'hasRealProperty', 'household'],
    [/^does (your|the) household have a trust$/, 'hasTrust', 'household'],
    [/^has (your|the) household sold or transferred property in the (last|past) 90 days$/, 'transferredProperty90Days', 'household'],
    [/^does (your|the) household have (other )?personal property$/, 'hasPersonalProperty', 'household'],
    [/^does (your|the) household own a vehicle$/, 'hasVehicle', 'household'],
    [/^does (your|the) household share resources with someone outside (your|the) household$/, 'sharesResourcesOutsideHousehold', 'household'],
    [/^has anyone in (your|the) household aged out of foster care$/, 'agedOutFosterCare', 'household'],
    [/^is anyone in (your|the) household homeless$/, 'householdHomeless', 'household'],
    [/^does anyone in (your|the) household have an iowa ebt card$/, 'hasIowaEbt', 'household'],
    [/^does anyone in (your|the) household receive benefits from another state$/, 'benefitsAnotherState', 'household']
  ]);
  const IOWA_KEYS = Object.freeze(IOWA_RULES.map(([, key]) => key));
  // Unlike the older general rules, keep parenthetical qualifications: "excluding heating" or
  // "for this person" changes what a saved household answer means.
  const iowaRule = text => IOWA_RULES.find(([pattern]) => pattern.test(normal(String(text || '').replace(QUESTION_NUMBER, '')).replace(/ (required|optional)$/, '')));
  const householdRulesOnly = doc => doc?.location?.href === 'https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/dynamicQuestions';
  // A household count by age, worked out by the desktop from birth dates: "householdCount:0-5" or
  // "householdCount:60+", whole numbers 0 to 120 without leading zeros. shared/household.cjs reads them the same way.
  const BAND_KEY = /^householdCount:(0|[1-9]\d{0,2})(?:-(0|[1-9]\d{0,2})|(\+))$/;
  function isBandKey(key) {
    const match = typeof key === 'string' ? BAND_KEY.exec(key) : null;
    return Boolean(match) && Number(match[1]) <= 120 && (Boolean(match[3]) || (Number(match[2]) <= 120 && Number(match[2]) >= Number(match[1])));
  }
  // Keys the rules may place beyond the profile's own: composites, a member's answer, band counts, answers from lists, and today's date.
  const ruleOnlyKey = key => MEMBER_KEYS.includes(key) || isBandKey(key) || IOWA_KEYS.includes(key) || CHOICE_KEYS.includes(key) || key === TODAY_KEY;
  // Answers that are only ever a guess for the applicant to review, however they were matched.
  const GUESS_KEYS = Object.freeze(['iowaResident']);
  const KIND = Object.freeze({ birthDate: 'date', todayDate: 'date', email: 'email', phone: 'tel', state: 'state', ageRange: 'ageRange', householdSize: 'count', householdAdults: 'count',
    householdChildren: 'count', householdSeniors: 'count', householdVeteran: 'yesno', householdDisability: 'yesno', totalMonthlyIncome: 'money',
    annualIncome: 'money', monthlyRent: 'money', monthlyUtilities: 'money', assetsOnHand: 'money', monthlyMedicalExpenses: 'money',
    householdAllCitizens: 'yesno', householdLegalStatus: 'yesno', householdPregnant: 'yesno', householdMedicare: 'yesno', anyoneSenior: 'yesno',
    iowaResident: 'yesno', wantsHealthCoverage: 'yesno', studentLevel: 'one', incomeSources: 'several', currentBenefits: 'several', helpWanted: 'several',
    ...Object.fromEntries(Object.values(BENEFIT_KEYS).map(key => [key, 'yesno'])) });
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
  // #184: questions answered from the saved lists. A benefit's yes or no is asked about the household ("you or anyone in your
  // family", "anyone in your household", "your household"), never about one person, and never about another state's benefits.
  const BENEFIT_WORDS = Object.freeze({ snap: 'snap|food stamps|snap food stamps|food stamps snap|calfresh', wic: 'wic',
    'cash-assistance': 'cash assistance|public assistance|tanf|fip|temporary assistance for needy families|family investment program', medicaid: 'medicaid',
    ssi: 'ssi|supplemental security income', housing: 'housing assistance|section 8|housing vouchers?|a housing voucher|rental assistance',
    'school-meals': 'free or reduced (price )?(school )?(meals|lunch|lunches)|free (school )?(meals|lunch|lunches)|school meals' });
  const HOUSEHOLD_WHO = '(you or anyone (in|of) (your |the )?(household|family|home)|anyone (in|of) (your |the )?(household|family|home)|you or any (member|one) of (your |the )?(household|family)|any (household|family) member|(your |the )?(household|family))';
  const BENEFIT_RULES = Object.entries(BENEFIT_WORDS).map(([code, words]) => [new RegExp(`^((do|does) ${HOUSEHOLD_WHO} (currently |now )?(receive|get)|(is|are) ${HOUSEHOLD_WHO} (currently |now )?(receiving|getting|on|enrolled in)) ` +
    `(${words})( benefits?)?( now| currently)?( through (?!.*\\b(another|other|out of) state\\b).+)?$`), BENEFIT_KEYS[code]]);
  const CHOICE_RULES = [
    [/^((current |your )?student (status|level|type|classification)|are you (currently |now )?(a |an )?(college |university )?student|what is your (current )?student (status|level))$/, 'studentLevel'],
    [/^((current |household )?(sources?|types?) of (household )?income( (and |or )?resources?| received)?|(current |household )?income (sources?|types?)|what are (your |the )?(households? )?(current )?sources of income|where does (your |the )?(households? )?income come from|(do|does) (you|your household|you or anyone in (your |the )?(household|family)) (currently )?receive income from (any of )?the following( sources)?)$/, 'incomeSources'],
    [/^((current|public|government) benefits( received| you receive)?|benefits (currently )?received|(which|what) (of the following )?benefits do (you|your household) (currently )?(receive|get)|(do|does) (you|your household|you or anyone in (your |the )?(household|family)) (currently )?(receive|get) any of the following( benefits| assistance| programs)?|(are you|is anyone in (your |the )?household) (currently )?receiving any of the following( benefits| assistance| programs)?)$/, 'currentBenefits'],
    [/^(((type|kind)s? of )?(assistance|help|services?|support)( (and |or )?information)? (needed|requested|wanted)|what (kind |type )?(of )?(help|assistance|services?|support) (do you need|are you (looking for|interested in)|would you like)|(which|what) services (are you interested in|do you need|would you like)|how can we help( you)?)$/, 'helpWanted'],
    ...BENEFIT_RULES
  ];
  // What an option says, as codes of the saved lists (shared/schema.cjs PROFILE_CHOICES.studentLevel and SEVERAL_CHOICES). An option
  // may name more than one ("SSI or SSDI"). One that starts with "not" or "no" names only None or Not a student.
  const CHOICE_OPTIONS = Object.freeze({
    studentLevel: Object.freeze({ 'not-student': /^(not a student|not (currently )?(a student|enrolled|in school)|non student)$/, 'high-school': /^high school\b/,
      undergraduate: /\bundergrad(uate)?\b/, graduate: /\b(graduate|grad|masters?|doctoral|phd)\b/, other: /^other\b/ }),
    incomeSources: Object.freeze({ job: /(?<!self )\b(jobs?|employment|employed|wages?|salary|paychecks?)\b|^work\b(?! study)/, 'self-employment': /\bself ?employ(ed|ment)\b|\bown business\b/,
      'financial-aid': /\b(financial aid|student loans?|scholarships?|pell grants?|student aid)\b/,
      'family-support': /\b(family|parents?|parental|relatives?)( or friends)? (support|help|money|contributions?|assistance)\b|\b(support|help|money) from (family|parents|relatives)\b|^(family|parents|relatives)$/,
      unemployment: /\bunemployment\b/, 'social-security': /\b(social security|ssi|ssdi|supplemental security income)\b/, 'child-support': /\bchild support\b/, pension: /\bpensions?\b/,
      other: /^other\b/, none: /^(none( of the (above|these))?|no income)$/ }),
    currentBenefits: Object.freeze({ snap: /\b(snap|food stamps?|calfresh)\b/, wic: /\bwic\b/, 'cash-assistance': /\b(cash assistance|public assistance|tanf|fip|temporary assistance for needy families|family investment program)\b/,
      medicaid: /\bmedicaid\b/, ssi: /\b(ssi|supplemental security income)\b/, housing: /\b(housing (assistance|vouchers?|choice vouchers?|subsidy)|section 8|public housing|rental assistance)\b/,
      'school-meals': /\b(free (or|and) reduced|free (school )?(lunch|lunches|meals)|reduced (price )?(school )?(lunch|lunches|meals)|school (lunch|lunches|meals))\b/,
      none: /^(none( of the (above|these))?|no benefits)$/ }),
    helpWanted: Object.freeze({ 'food-pantry': /\bpantry\b/, 'fresh-produce': /\b(fresh (food|produce|fruits?|vegetables?)|produce|fruits? (and|or) vegetables?)\b/,
      'food-vouchers': /\b(vouchers?|meal (tickets?|swipes?))\b/, 'gift-cards': /\b(gift ?cards?|grocery cards?)\b/, 'snap-help': /\b(snap|food stamps?)\b/,
      'social-services': /\b(social (services?|work(ers?)?)|case management)\b/, other: /^other\b/ })
  });
  const NEGATED = /^(not|no|non)\b/;
  const optionCodes = (key, option) => {
    const text = normal(option);
    return Object.entries(CHOICE_OPTIONS[key]).filter(([code, pattern]) => pattern.test(text) && (!NEGATED.test(text) || ['none', 'not-student'].includes(code))).map(([code]) => code);
  };
  // The options a saved answer checks: for each saved choice, the one option that names it. A saved choice that names more than
  // one option (On-Campus Job and Off-Campus Job are both a job) checks none of them, and leaves the question `ambiguous`.
  function chosenOptions(key, options, value) {
    const named = options.map(option => optionCodes(key, option));
    const picks = new Set();
    let ambiguous = false;
    for (const code of String(value).split(',').filter(Boolean)) {
      const naming = named.flatMap((codes, index) => codes.includes(code) ? [index] : []);
      if (naming.length > 1) ambiguous = true;
      else if (naming.length) picks.add(naming[0]);
    }
    return { picks: [...picks].sort((a, b) => a - b), ambiguous };
  }
  // Checkbox groups SecondHand answered in part (#184), by their first box: the boxes it checked. While those are still the
  // only boxes checked, the question needs the applicant for the options it left.
  const answeredInPart = new WeakMap();
  const inPart = entry => entry.kind === 'checkbox' && answeredInPart.has(entry.elements[0]) &&
    entry.elements.every(box => box.checked === answeredInPart.get(entry.elements[0]).includes(box));
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
  // Labels are read without apostrophes, so a possessive is the role with an s ("child’s" is "childs").
  // A guardian or parent may be the applicant, but saying so would be a guess: their boxes stay with the applicant.
  const OTHER_PERSON_ROLE = /\b(spouses?|partners?|husbands?|wifes?|wives|helpers?|proxys?|proxies|emergency contacts?|references?|landlords?|guardians?|parents?|conyuge|esposo|esposa|pareja|dependiente|ayudante|contacto de emergencia|referencia|propietario|arrendador|tutor legal)\b|\brepresentatives?\b|\brepresentante\b/;
  // Always someone else: a family member, a numbered household member, another or additional one, or a box
  // that only says "Household member".
  const MEMBER_DETAIL = /^household members?$|\b(family member|household member (number )?\d+|(other|additional|another) (household |family )?(members?|persons?|people|adults?|individuals?)( of (the |your )?(household|family|home))?|miembro de(l| la)? (familia|casa|hogar))\b/;
  // Someone other than the applicant when the question asks for their details: a child, a student, a
  // dependent, or household members. A count of them ("Number of children") stays the applicant's. One
  // household member is another person when the label leads with them ("Household member name");
  // "Name of household member" is how USDA TEFAP forms ask for the applicant.
  const CHILD_ROLE = /^household member\b|\b((grand)?childs?|(grand)?childrens?|kids?|sons?|daughters?|students?|dependents?|household members|family members|hijos?|hijas?|estudiantes?)\b/;
  const PERSON_DETAIL = /\b(names?|first|last|middle|nombres?|apellidos?|birth\w*|dob|nacimiento|address(es)?|direccion|phone|telephone|cell|telefono|e ?mail|relation\w*|school|escuela)\b/;
  const COMBINED_ADDRESS_QUESTION = /^(city (and )?state|city (and )?(zip|zip code|zipcode|postal code)|city (and )?state (and )?(zip|zip code|zipcode|postal code)|(complete|full) (physical |home |residential )?address( including (town|city|town city))?|ciudad (y )?estado|ciudad (y )?codigo postal|ciudad (y )?estado (y )?codigo postal|direccion completa)$/;
  const PERSON_NOT_AMOUNT = /^(who|que persona|quien) (pays?|paga)( |$)/;
  function otherPersonQuestion(value) {
    const text = normal(value);
    const representative = !(text.startsWith('household representative ') || text === 'household representative') && OTHER_PERSON_ROLE.test(text);
    return representative || MEMBER_DETAIL.test(text) || (CHILD_ROLE.test(text) && PERSON_DETAIL.test(text));
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
  // The question may go on in a sentence of its own ("Student name and grade. Order will be assigned to…"):
  // its first sentence is asked as the question too.
  const firstSentence = text => String(text || '').split(/[.?!](?:\s|$)/)[0];
  const memberRuleFor = text => MEMBER_RULES.find(([pattern]) => pattern.test(question(text)) || pattern.test(question(firstSentence(text))))?.[1] || null;
  function ruleFor(text) {
    const asked = question(text);
    return [...RULES, ...CHOICE_RULES].find(([pattern]) => pattern.test(asked))?.[1] || bandRule(asked);
  }
  // Questions only the applicant answers: no saved field and no AI answer goes to consent, signatures,
  // attestations, agreements, terms, Social Security numbers, secrets, texted, emailed or verification codes,
  // security questions, or user names. Only the SSN box's own rule places the saved SSN (match).
  // shared/laya-prompts.cjs keeps an identical copy for the desktop app.
  const UNSAFE_QUESTION = /^social security$|^(enter )?(the |your |a )?codes?$|\b(consent\w*|sign|signs|signed|signing|signature\w*|initials|attest\w*|certif\w*|agree|agrees|agreed|agreement\w*|terms|acknowledg\w*|authoriz\w*|permission|perjury|i understand|i confirm|i have read|true and (correct|accurate|complete)|privacy|social security (number|no|num|card)|ss number|ssn|itin|password|passcode|pin|cvv|cvc|card number|credit card|debit card|security code|captcha|one time|otp|2fa|mfa|(verification|verify|authentication|confirmation|access|login|log in|sms|text|texted|email|emailed) codes?|\d+ digit codes?|codes? (that |which )?(we |was |were |has been |have been )?(just )?(sent|texted|emailed)|(sent|texted|emailed) (to )?(you )?(a |the |your )?codes?|codes? from (the |your |our )?(text|sms|email|e mail|message|app)|(security|secret|challenge) (questions?|answers?)|mothers maiden name|(city|town) (were you|you were|was your \w+) born|born in what (city|town)|first (pets?|car)|street (did you|you) gr[eo]w up on|user ?names?|user ?ids?|(login|log in) (ids?|names?)|screen ?names?)\b/;
  const unsafeQuestion = field => [field?.label, ...(Array.isArray(field?.options) ? field.options : [])].some(text => UNSAFE_QUESTION.test(normal(text)));
  // Custom answers have no approved financial/credential exception. Keep this in step with
  // shared/custom-fields.cjs so direct assignments cannot bypass its desktop release guard.
  const CUSTOM_PROTECTED = /\b(payment|billing|routing|iban|swift|bank account|bank details|account (number|no|num)|credit|debit|cardholder|card holder|card expiry|card expiration|cvc|cvv|pin|passphrase|security answer|recovery key|recovery phrase|seed phrase|secret key|api key|authentication|verification|captcha)\b/;
  const protectedCustom = field => [field?.label, ...(Array.isArray(field?.options) ? field.options : [])].some(value => CUSTOM_PROTECTED.test(normal(value)));
  // The questions Laya, the desktop app's AI, may take, within the bridge's limits: a text box to match
  // to a saved field ('text') or a choice question to answer ('choice'). Never one only the applicant answers,
  // and never a text box no saved field may go to (another person's, who pays, a combined address), which
  // the desktop's matchableBox refuses too.
  const LAYA = Object.freeze({ text: Object.freeze(['text', 'textarea', 'number', 'date', 'email', 'tel']), choice: Object.freeze(['radio', 'select', 'checkbox']),
    label: 200, options: 30, option: 100 });
  // The bridge's rule for page text (UNSEEN in desktop/bridge.cjs): no character that reorders, hides, or breaks the
  // words around it, but the non-joiner and joiner Persian, Arabic, and Indic words need. A question with one stays
  // with the applicant: the bridge would refuse the whole request.
  const UNSEEN = /[[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]--[\u200C\u200D]]/v;
  const layaText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !UNSEEN.test(value);
  function layaQuestion({ label, type, options }) {
    if (!layaText(label, LAYA.label) || !Array.isArray(options) || options.length > LAYA.options || options.some(option => !layaText(option, LAYA.option)) ||
      new Set(options).size !== options.length || unsafeQuestion({ label, options }) || iowaRule(label)) return '';
    if (LAYA.text.includes(type)) return blockedSuggestion(label) ? '' : 'text';
    return LAYA.choice.includes(type) && options.length ? 'choice' : '';
  }
  // Whether a guess (the AI step) may offer a key for a question: never for one only the applicant
  // answers. A birth date only goes to a whole-date question about birth, never to "Date ordered",
  // a month box, or a child's birthday.
  function canSuggest(key, field) {
    if (!GENERIC_KEYS.includes(key)) return false;
    if (unsafeQuestion(field) || blockedSuggestion(field?.label) || iowaRule(field?.label)) return false;
    if (key !== 'birthDate') return true;
    const text = question(field?.label);
    return /\b(birth|born|dob)/.test(text) && !/\b(month|day|year|time|hours?|minutes?)\b/.test(text) && !OTHER_PERSON.test(text);
  }

  // Only open roots in this document: never a frame's document or a closed shadow tree.
  function deepQueryAll(doc, selector) {
    const found = [], seen = new Set();
    function visit(scope) {
      if (seen.has(scope)) return; seen.add(scope);
      for (const element of scope.querySelectorAll('*')) {
        if (element.ownerDocument !== doc) continue;
        if (element.matches(selector)) found.push(element);
        if (element.shadowRoot?.mode === 'open') visit(element.shadowRoot);
      }
    }
    visit(doc); return found;
  }
  const parentOf = element => element.parentElement || element.getRootNode()?.host || null;
  function closestAcross(element, selector) { for (let node = element; node; node = parentOf(node)) if (node.matches?.(selector)) return node; return null; }
  const rootOf = element => element.getRootNode();
  const idsIn = (scope, id) => Array.from(scope.querySelectorAll('[id]')).filter(node => node.id === id);
  function rootId(element, id) { const matches = idsIn(rootOf(element), id); return matches.length === 1 ? matches[0] : null; }

  // A label's own aria-hidden only hides it from screen readers (Jotform marks every choice
  // label that way), so a choice label is checked with `labelOnly`; an aria-hidden ancestor still hides it.
  function rendered(element, labelOnly = false) {
    const win = element.ownerDocument.defaultView;
    if (!win || !element.isConnected) return false;
    for (let node = element; node && node.nodeType === 1; node = parentOf(node)) {
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
    copy.querySelectorAll('input, select, textarea, button, script, style, [contenteditable], [role="textbox"], [role="combobox"]').forEach(control => control.remove());
    return clean(copy.textContent);
  }
  function idsText(scope, ids) { return clean(String(ids || '').split(/\s+/).filter(Boolean).map(id => (scope.nodeType === 1 ? rootId(scope, id) : scope.getElementById(id))?.textContent || '').join(' ')); }
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
    return idsText(box, box.getAttribute('aria-labelledby')) || clean(box.getAttribute('aria-label')) || (legend ? textWithoutControls(legend) : '') ||
      clean(box.querySelector('[role="heading"]')?.textContent);
  }
  function enclosingQuestion(node, doc) {
    for (let box = closestAcross(parentOf(node), QUESTION_BOX); box; box = closestAcross(parentOf(box), QUESTION_BOX)) {
      const text = boxHeading(box, doc);
      if (text) return { box, text };
    }
    return null;
  }
  // "Date", "Month", "Hour"… name a part of a question, not the question itself.
  const DATE_PART = /^(date|month|day|year|time|hours?|minutes?)$/;
  function labelsFor(element, doc) {
    const ownLabels = element.labels || (element.id ? Array.from(rootOf(element).querySelectorAll('label')).filter(node => node.htmlFor === element.id) : []);
    const candidates = [idsText(element, element.getAttribute('aria-labelledby')), clean(element.getAttribute('aria-label')),
      ...Array.from(ownLabels, textWithoutControls), clean(element.getAttribute('placeholder'))];
    const present = candidates.filter(Boolean);
    const labels = present.length ? present : [precedingText(element)].filter(Boolean);
    return labels.map(text => {
      const asked = enclosingQuestion(element, doc)?.text;
      // Under another person's heading ("Emergency contact", "Child 1", "Partner’s information"), a box asks for that person's detail.
      if (asked && normal(asked) !== normal(text) && (otherPersonQuestion(asked) || otherPersonQuestion(`${asked}: ${text}`))) return `${asked}: ${text}`;
      if (!DATE_PART.test(normal(text))) return text;
      return asked && normal(asked) !== normal(text) ? `${asked}: ${text}` : text;
    });
  }
  // Form builders such as Google Forms draw choices as div[role=radio|checkbox|listbox], not native controls.
  const ARIA_CONTROLS = '[role="radio"], [role="checkbox"], [role="switch"], [role="listbox"], [role="combobox"]';
  const EDITABLE = '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
  const ARIA_TYPES = Object.freeze({ ariaRadio: 'radio', ariaCheckbox: 'checkbox', ariaSwitch: 'checkbox', ariaListbox: 'select', ariaCombo: 'select' });
  const ariaUsable = element => (!element.matches('input, select, textarea') || element.getAttribute('role') === 'combobox') && !element.disabled && !element.readOnly && element.getAttribute('aria-disabled') !== 'true' && element.getAttribute('aria-readonly') !== 'true' && rendered(element);
  const editableUsable = element => element.matches(EDITABLE) && !closestAcross(parentOf(element), EDITABLE) && !element.querySelector('input,select,textarea,button,[contenteditable]') && element.getAttribute('aria-readonly') !== 'true' && element.getAttribute('aria-disabled') !== 'true' && rendered(element);
  function listboxFor(entry) {
    if (entry.kind === 'ariaListbox') return entry.group;
    const ids = String(entry.group.getAttribute('aria-controls') || entry.group.getAttribute('aria-owns') || '').trim().split(/\s+/);
    const list = ids.length === 1 && ids[0] ? rootId(entry.group, ids[0]) : null;
    return list?.getAttribute('role') === 'listbox' ? list : null;
  }
  // Radios group by their radiogroup; checkboxes by the question they sit in; a listbox stands alone.
  function ariaGroup(element, doc) {
    const role = element.getAttribute('role');
    if (role === 'combobox') return { kind: 'ariaCombo', group: element };
    if (role === 'switch') return { kind: 'ariaSwitch', group: element };
    if (role === 'listbox') return { kind: 'ariaListbox', group: element };
    if (role === 'radio') { const group = element.closest('[role="radiogroup"]'); return group ? { kind: 'ariaRadio', group } : null; }
    return { kind: 'ariaCheckbox', group: enclosingQuestion(element, doc)?.box || element };
  }
  function ariaLabels(entry, doc) {
    if (entry.group === entry.elements[0] && ['ariaCheckbox', 'ariaSwitch', 'ariaCombo', 'ariaListbox'].includes(entry.kind)) return labelsFor(entry.group, doc).length ? labelsFor(entry.group, doc) : [boxHeading(entry.group, doc) || enclosingQuestion(entry.group, doc)?.text || ariaOptionText(entry.group)].filter(Boolean);
    return [boxHeading(entry.group, doc) || enclosingQuestion(entry.group, doc)?.text || precedingText(entry.group)].filter(Boolean);
  }
  function ariaRequired(entry, doc) {
    if ([entry.group, ...entry.elements].some(element => element.getAttribute('aria-required') === 'true')) return true;
    const box = enclosingQuestion(entry.group, doc)?.box || entry.group;
    return Boolean(box.querySelector('[aria-label*="required" i]')) || /\*\s*$/.test(box.querySelector('[role="heading"], legend')?.textContent || '');
  }
  const ariaOptionValue = option => option.hasAttribute('data-value') ? option.getAttribute('data-value') : clean(option.textContent);
  const ariaOptionText = option => clean(option.getAttribute('aria-label') || option.getAttribute('data-value') || option.getAttribute('data-answer-value') || option.textContent);
  const listboxOptions = listbox => listbox ? Array.from(listbox.querySelectorAll('[role="option"]')).filter(option => option.closest('[role="listbox"]') === listbox && ariaOptionValue(option)) : [];
  function groupQuestion(elements, doc) {
    const first = elements[0];
    const container = first.closest('fieldset, [role="radiogroup"], [role="group"]');
    const candidates = [];
    if (container) {
      candidates.push(textWithoutControls(container.querySelector('legend') || doc.createElement('i')), idsText(container, container.getAttribute('aria-labelledby')), clean(container.getAttribute('aria-label')));
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
  const explicitNo = new WeakMap();
  function answered(entry) {
    if (entry.kind === 'editable') return Boolean(clean(entry.elements[0].textContent));
    if (['ariaRadio', 'ariaCheckbox', 'ariaSwitch'].includes(entry.kind)) return entry.elements.some(element => element.getAttribute('aria-checked') === 'true' || explicitNo.get(element) === element.getAttribute('aria-checked'));
    if (['ariaListbox', 'ariaCombo'].includes(entry.kind)) return listboxOptions(listboxFor(entry)).some(option => option.getAttribute('aria-selected') === 'true') || Boolean(entry.group.value || entry.group.getAttribute('aria-valuetext'));
    return entry.kind === 'radio' || entry.kind === 'checkbox' ? entry.elements.some(element => element.checked || (entry.kind === 'checkbox' && explicitNo.get(element) === 'false' && !element.checked))
      : entry.kind === 'select' ? Array.from(entry.elements[0].selectedOptions).some(option => Boolean(option.value)) : Boolean(String(entry.elements[0].value || '').trim());
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
    if (entry.kind === 'checkbox') return ['Yes', 'No'];
    if (entry.kind === 'ariaRadio' || (entry.kind === 'ariaCheckbox' && entry.elements.length > 1)) return entry.elements.map(ariaOptionText);
    if (['ariaCheckbox', 'ariaSwitch'].includes(entry.kind)) return ['Yes', 'No'];
    if (['ariaListbox', 'ariaCombo'].includes(entry.kind)) return listboxOptions(listboxFor(entry)).map(ariaOptionText);
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
  // #258: the questions today's date answers, in the words pantry forms ask them. A bare "Date" only directly after a signature
  // line (besideSignature). Never one about a birth, start, move-in, due or end date, and never on Iowa's portal.
  const TODAY_QUESTION = /^(todays date|today|date ordered|order date|date of (visit|request|application)|(visit|request|application) date)$/;
  const NOT_TODAY = /\b(birth\w*|born|dob|start\w*|move in|moved in|moving in|due|end|ends|ending|ended)\b/;
  // A date box's words after its question: the order it is written in ("MM/DD/YYYY"), and the part a split date's box holds ("Month").
  const DATE_HINT = /(^| )(mm? dd? (yyyy|yy)|dd? mm? (yyyy|yy)|yyyy mm? dd?)$/;
  const SPLIT_PART = /(^| )(month|day|year)$/;
  // What a label asks of a date ('' when it only names a part or an order), and the part its box holds: Google's "Date ordered:
  // Date" asks "date ordered" for the whole date, Jotform's "Date ordered Month" for its month.
  function dateLabel(text) {
    let asked = question(text).replace(DATE_HINT, '');
    const part = SPLIT_PART.exec(asked);
    if (part) asked = asked.slice(0, part.index);
    if (!TODAY_QUESTION.test(asked) && / date$/.test(asked)) asked = asked.slice(0, -' date'.length);
    return { asked, part: part ? part[2] : null };
  }
  // The applicant's own signature line. A staff member's or a guardian's isn't theirs.
  const SIGNATURE_LINE = /^((applicant|applicants|your|client|clients|participant|participants|electronic|e) )?signature( of (the )?(applicant|client|participant))?$|^sign here$/;
  const QUESTION_WORDS = 'label, legend, [role="heading"]';
  // Whether a box comes directly after a signature line: past the box's own words ("Date", "Month"), the question before it, in
  // the same form, is the signature.
  function besideSignature(element) {
    const doc = element.ownerDocument, form = closestAcross(element, 'form');
    const before = Array.from(rootOf(element).querySelectorAll(QUESTION_WORDS)).filter(node => !node.contains(element) && rendered(node, true) &&
      Boolean(node.compareDocumentPosition(element) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING));
    let index = before.length - 1;
    while (index >= 0 && ['', 'date'].includes(dateLabel(textWithoutControls(before[index])).asked)) index--;
    return index >= 0 && closestAcross(before[index], 'form') === form && SIGNATURE_LINE.test(question(textWithoutControls(before[index])));
  }
  // What a box asks of today's date: 'date' for the whole date, or the part of a split date its box holds. Null when it asks
  // anything else: each of its labels asks for today's date, or only says "Date" directly after a signature line, and they name one part at most.
  function todayAsked(entry) {
    const element = entry.elements[0], doc = element.ownerDocument;
    if (entry.kind !== 'input' || doc.location.origin === 'https://hhsservices.iowa.gov' || entry.labels.some(label => NOT_TODAY.test(normal(label)))) return null;
    const labels = entry.labels.map(dateLabel);
    const parts = [...new Set(labels.map(label => label.part).filter(Boolean))];
    const phrase = labels.find(label => TODAY_QUESTION.test(label.asked))?.asked || 'date';
    if (parts.length > 1 || !labels.every(label => ['', 'date', phrase].includes(label.asked)) || !labels.some(label => label.asked === phrase)) return null;
    if (phrase === 'date' && !besideSignature(element)) return null;
    const part = parts[0] || 'date';
    // A split date is one answer: a box of it the applicant began (one SecondHand didn't fill) leaves the rest to them.
    const form = closestAcross(element, 'form');
    const begun = other => other.kind === 'input' && other.elements[0] !== element && closestAcross(other.elements[0], 'form') === form && answered(other) &&
      !other.elements[0].hasAttribute('data-secondhand-filled') && other.labels.some(label => { const asked = dateLabel(label); return Boolean(asked.part) && asked.asked === phrase; });
    return part !== 'date' && questionsOn(doc).some(begun) ? null : part;
  }
  // A key is only placed on a control that can hold its kind of answer.
  const answerKind = key => IOWA_KEYS.includes(key) ? 'yesno' : isBandKey(key) ? 'count' : KIND[key] || 'text';
  function compatible(key, entry) {
    const kind = answerKind(key);
    const type = (entry.elements[0].type || 'text').toLowerCase();
    const options = optionsOf(entry);
    const choice = ['radio', 'ariaRadio', 'ariaCombo', 'ariaListbox'].includes(entry.kind);
    const toggle = ['checkbox', 'ariaCheckbox', 'ariaSwitch'].includes(entry.kind) && entry.elements.length === 1;
    if (IOWA_KEYS.includes(key)) return (choice || entry.kind === 'select') && options.length === 2 &&
      options.map(normal).sort().join('|') === 'no|yes';
    if (kind === 'yesno') return (choice || entry.kind === 'select') ? isYesNo(options) : toggle;
    if (kind === 'ageRange') return (choice || entry.kind === 'select') && options.some(ageRange);
    // A question answered from a list needs options that name its answers: one choice for the student status, any for the rest.
    if (kind === 'one') return (choice || entry.kind === 'select') && options.some(option => optionCodes(key, option).length);
    if (kind === 'several') return entry.kind === 'checkbox' && entry.elements.length > 1 && options.some(option => optionCodes(key, option).length);
    if (kind === 'count') return (entry.kind === 'input' && ['number', 'text', 'tel', ''].includes(type)) || ((entry.kind === 'select' || choice) && isNumeric(options.filter(option => normal(option))));
    if (kind === 'state') return ['select', 'ariaCombo', 'ariaListbox'].includes(entry.kind) || (entry.kind === 'input' && type === 'text');
    // Today's date goes in a date or text box, and its parts in a split date's own boxes (Jotform's are tel).
    if (key === TODAY_KEY) { const part = todayAsked(entry); return Boolean(part) && (part === 'date' ? ['date', 'text', ''] : ['text', 'tel', 'number', '']).includes(type); }
    if (kind === 'date') return entry.kind === 'input' && ['date', 'text', ''].includes(type);
    if (kind === 'email') return entry.kind === 'input' && ['email', 'text'].includes(type);
    if (kind === 'tel') return entry.kind === 'input' && ['tel', 'text', 'number'].includes(type);
    if (kind === 'money') return entry.kind === 'input' && ['number', 'text', ''].includes(type);
    return ['textarea', 'editable', 'select', 'ariaCombo', 'ariaListbox'].includes(entry.kind) || (entry.kind === 'input' && ['text', 'search', ''].includes(type));
  }
  // A box only the applicant answers, by any of its labels or options.
  const applicantOnly = entry => unsafeQuestion({ label: entry.labels.join(' '), options: optionsOf(entry) });
  // Such a box gets no saved field, not even from a rule or its autocomplete hint. The one exception
  // is the Social Security number box: its own rule places the saved SSN, and nothing else goes there.
  function match(entry) {
    const result = ruleMatch(entry);
    return result.key && result.key !== 'ssn' && applicantOnly(entry) ? { key: null, confidence: null } : result;
  }
  function iowaScope(entry, scope) {
    const doc = entry.elements[0].ownerDocument;
    if (entry.elements.some(element => element.matches(':disabled'))) return false;
    let url;
    try { url = new URL(doc.location.href); } catch { return false; }
    if (url.origin !== 'https://hhsservices.iowa.gov' || url.username || url.password || /[%\\]/.test(url.pathname) ||
        !(url.pathname === '/apspssp/ssp.portal' || url.pathname.startsWith('/apspssp/ssp.portal/'))) return false;
    const form = entry.elements[0].form || entry.elements[0].closest('form');
    if (!form || entry.elements.some(element => (element.form || element.closest('form')) !== form)) return false;
    for (let node = entry.elements[0].parentElement; node; node = node.parentElement) {
      const context = `${node.getAttribute('aria-label') || ''} ${idsText(doc, node.getAttribute('aria-labelledby'))}`;
      if (otherPersonQuestion(context) || /\b(employer|helper|assisting|representative|another person|other person)\b/.test(normal(context))) return false;
    }
    // A selected person or detail row cannot silently turn an applicant/household answer into
    // somebody else's answer. Names/identifiers are not used to infer who that person is.
    if (Array.from(form.querySelectorAll('select, input')).some(element => rendered(element) && /personSelection|householdMember|employer|helper|representative/i.test(`${element.name} ${element.id}`))) return false;
    const headings = Array.from(doc.querySelectorAll('h1,h2,h3,h4,legend')).filter(element => rendered(element)).map(element => clean(element.textContent));
    if (headings.some(text => otherPersonQuestion(text) || /\b(employer|helper|assisting|representative|another person|other person|certification|e signature)\b/.test(normal(text)))) return false;
    if (scope === 'household') return true;
    const start = doc.querySelectorAll('a[title="Start Application | Active"]'), people = doc.querySelectorAll('a[title="People | Unvisited"]');
    return start.length === 1 && people.length === 1 && start[0].parentElement.classList.contains('current') && people[0].parentElement.classList.contains('next') &&
      rendered(start[0]) && rendered(people[0]) && Array.from(doc.querySelectorAll('p')).some(element => rendered(element) &&
        clean(element.textContent).startsWith('Please give us additional information about yourself. If you cannot answer a question you can skip it.'));
  }
  function iowaEntryState(entry) {
    const doc = entry.elements[0].ownerDocument, form = entry.elements[0].form || entry.elements[0].closest('form');
    return JSON.stringify({ url: doc.location.href, labels: entry.labels, options: optionsOf(entry),
      controls: entry.elements.map(element => [element.id, element.name, element.type, element.getAttribute('value'), element.getAttribute('onchange'), element.getAttribute('onclick')]),
      form: form && [form.id, form.getAttribute('action'), form.getAttribute('method')],
      headings: Array.from(doc.querySelectorAll('h1,h2,h3,h4,legend,p,a[title]')).filter(element => rendered(element)).map(element => [element.tagName, element.getAttribute('title'), clean(element.textContent)]) });
  }
  function ruleMatch(entry) {
    if (entry.invalidLabels) return { key: null, confidence: null };
    const element = entry.elements[0];
    const iowa = entry.labels.map(iowaRule).filter(Boolean);
    if (iowa.length) {
      const [, key, scope] = iowa[0];
      return iowa.every(rule => rule[1] === key) && (!householdRulesOnly(element.ownerDocument) || scope === 'household') && iowaScope(entry, scope) && compatible(key, entry)
        ? { key, confidence: 'high' } : { key: null, confidence: null };
    }
    if (householdRulesOnly(element.ownerDocument)) return { key: null, confidence: null };
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
    // Today's date is placed by its labels alone, never by a box's name.
    if (compatible(TODAY_KEY, entry)) return { key: TODAY_KEY, confidence: 'high' };
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
    const roots = new Map();
    const controls = deepQueryAll(doc, `input, select, textarea, ${ARIA_CONTROLS}, ${EDITABLE}`);
    const ownedLists = new Set(controls.filter(element => element.getAttribute('role') === 'combobox').map(group => listboxFor({ group, kind: 'ariaCombo' })).filter(Boolean));
    for (const element of controls) {
      if (ownedLists.has(element)) continue;
      if (element.matches(EDITABLE) && !element.matches(ARIA_CONTROLS)) {
        if (editableUsable(element)) entries.push({ kind: 'editable', elements: [element] });
        continue;
      }
      if (!element.matches('input, select, textarea') || element.getAttribute('role') === 'combobox') {
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
        const tree = rootOf(element);
        if (!roots.has(tree)) roots.set(tree, roots.size);
        const forms = Array.from(tree.querySelectorAll('form'));
        const groupKey = `${roots.get(tree)}|${kind}|${element.form ? forms.indexOf(element.form) : -1}|${element.name}`;
        if (groups.has(groupKey)) { groups.get(groupKey).elements.push(element); continue; }
        const entry = { kind, elements: [element] };
        groups.set(groupKey, entry); entries.push(entry);
      } else entries.push({ kind, elements: [element] });
    }
    // A label id no open root defines is skipped, as a browser skips it: Google Forms labels each question with its error
    // message's id before that message exists. An id defined only in another root, or twice in this one, leaves the label unknown.
    let pageIds = null;
    function badReference(element, id) {
      const here = idsIn(rootOf(element), id).length;
      if (here) return here > 1;
      if (!pageIds) pageIds = new Set(deepQueryAll(doc, '[id]').map(node => node.id));
      return pageIds.has(id);
    }
    for (const entry of entries) {
      const grouped = entry.kind === 'radio' || (entry.kind === 'checkbox' && entry.elements.length > 1);
      entry.labels = ARIA_TYPES[entry.kind] ? ariaLabels(entry, doc) : grouped ? groupQuestion(entry.elements, doc) : labelsFor(entry.elements[0], doc);
      if (ARIA_TYPES[entry.kind]) entry.required = ariaRequired(entry, doc);
      entry.invalidLabels = [entry.group, ...entry.elements].filter(Boolean).some(element =>
        (element.id && rootId(element, element.id) !== element) || String(element.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean).some(id => badReference(element, id)));
    }
    return entries;
  }
  function scan(doc) {
    // A div question is only safe to leave to the rules when nothing on it asks for secrets. One SecondHand answered in part stays.
    return questionsOn(doc).filter(entry => (!answered(entry) || inPart(entry)) && !(ARIA_TYPES[entry.kind] && UNSAFE.test(normal(entry.labels.join(' ')))));
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
    return { label: entry.labels[0] || '', type: entry.kind === 'input' ? (first.type || 'text') : entry.kind === 'editable' ? 'textarea' : ARIA_TYPES[entry.kind] || entry.kind, options: optionsOf(entry),
      required: entry.required ?? (entry.elements.some(element => element.required || element.getAttribute('aria-required') === 'true') || /\*\s*$/.test(entry.labels.join(' '))) };
  }
  function plan(doc) {
    const token = `plan-${Date.now().toString(36)}-${++sequence}`;
    const map = new Map();
    const matched = [], unmatched = [];
    const entries = scan(doc), rules = entries.map(match);
    entries.forEach((entry, index) => {
      const id = `sh-${sequence}-${index}`;
      entry.binding = binding(entry);
      map.set(id, entry);
      const result = rules[index];
      if (IOWA_KEYS.includes(result.key) && rules.filter(rule => rule.key === result.key).length !== 1) { unmatched.push({ id, ...fieldOf(entry) }); return; }
      if (IOWA_KEYS.includes(result.key)) entry.iowaState = iowaEntryState(entry);
      // Answered in part (#184): it still needs the applicant, and nothing fills it again.
      if (result.confidence === 'high') { matched.push({ id, key: result.key, confidence: 'high', label: entry.labels[0] || '', ...(inPart(entry) ? { partial: true } : {}) }); return; }
      unmatched.push({ id, ...fieldOf(entry) });
    });
    current = { token, doc, map };
    return { token, matched, unmatched };
  }

  // Save to My information. Which of the listed boxes of the current plan now hold an answer: their ids
  // only, never what they hold.
  function answeredIds(doc, token, ids) {
    if (!current || current.token !== token || current.doc !== doc || !Array.isArray(ids)) return [];
    return ids.filter(id => { const entry = current.map.get(id); return Boolean(entry) && entry.elements.every(element => element.isConnected) && answered(entry); });
  }
  // After the applicant's click: one listed box's answer, in the profile's own format. Only for the
  // saved field the rules matched to that box, never a password, code, signature or SSN box. Null when
  // the box may not be read; { empty } when it holds no answer; { unreadable } when its answer doesn't fit the field;
  // { repeated } when the page asks for the field in more than one box.
  const DATE_TYPED = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
  // The orders a date box asks for ("MM/DD/YYYY", "dd/mm/aaaa", "jj/mm/aaaa", "YYYY-MM-DD") in its labels, placeholder,
  // description or title, each read on its own. Save reads a typed date in it (#142), and a fill writes the saved date in it (#156).
  const DATE_ORDERS = Object.freeze({ month: /\bmm? dd? (yyyy|yy|aaaa|aa)\b/, day: /\b(dd?|jj?) mm? (yyyy|yy|aaaa|aa)\b/, year: /\b(yyyy|aaaa) mm? dd?\b/ });
  function dateOrders(entry) {
    const element = entry.elements[0];
    const hints = [...entry.labels, idsText(element, element.getAttribute('aria-describedby')), element.getAttribute('title') || ''].map(normal);
    return new Set(Object.keys(DATE_ORDERS).filter(order => hints.some(hint => DATE_ORDERS[order].test(hint))));
  }
  // The order a typed date is in: as its box asks for it, or as its numbers allow only one way. Null when it can't be told: never guessed.
  function typedDate(text, entry) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const typed = DATE_TYPED.exec(text);
    if (!typed) return null;
    const orders = dateOrders(entry);
    const [first, second] = [Number(typed[1]), Number(typed[2])];
    const monthFirst = orders.has('month'), dayFirst = orders.has('day');
    let leads = null;
    if (monthFirst !== dayFirst) leads = monthFirst ? 'month' : 'day';
    else if (first === second || (first <= 12 && second > 12)) leads = 'month';
    else if (first > 12 && second <= 12) leads = 'day';
    if (!leads) return null;
    const [month, day] = leads === 'month' ? [first, second] : [second, first];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${typed[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  function answerIn(entry, key) {
    const first = entry.elements[0];
    const kind = answerKind(key);
    const chosen = entry.kind === 'radio' ? entry.elements.find(element => element.checked) : null;
    const text = entry.kind === 'select' ? clean(first.selectedOptions[0]?.textContent) || first.value : chosen ? optionText(chosen) : String(first.value || '').trim();
    if (kind === 'yesno') {
      if (entry.kind === 'checkbox') return first.checked ? 'yes' : null;
      return /^yes\b/.test(normal(text)) ? 'yes' : /^no\b/.test(normal(text)) ? 'no' : null;
    }
    if (kind === 'count') {
      if (entry.kind === 'input') return /^\d{1,2}$/.test(text) ? String(Number(text)) : null;
      const count = countOf(text);
      return count && !count.orMore ? String(count.number) : null;
    }
    if (kind === 'money') {
      const amount = text.replace(/^\$\s*/, '').replace(/,(?=\d{3}(\D|$))/g, '');
      return /^\d{1,8}(\.\d{1,2})?$/.test(amount) ? amount : null;
    }
    if (kind === 'date') return typedDate(text, entry);
    if (kind === 'state') {
      if (entry.kind === 'select' && Object.hasOwn(STATES, String(first.value).toUpperCase())) return String(first.value).toUpperCase();
      const code = Object.keys(STATES).find(state => state === text.toUpperCase() || STATES[state] === normal(text));
      return code || null;
    }
    return text.length <= 200 ? text : null;
  }
  function readAnswer(doc, token, id, key) {
    if (!SAVE_KEYS.includes(key) || !current || current.token !== token || current.doc !== doc) return null;
    const entry = current.map.get(id);
    if (!entry || ARIA_TYPES[entry.kind] || !entry.elements.every(element => element.isConnected && eligible(element))) return null;
    const label = entry.labels.join(' ');
    if (match(entry).key !== key || applicantOnly(entry) || CODE.test(normal(label)) || otherPersonQuestion(label)) return null;
    // The page asks for this field in more than one box, as a household member's section with no heading of its own
    // does: whose answer each box holds can't be told, so none is read as the applicant's (#142).
    if (questionsOn(doc).filter(other => match(other).key === key).length > 1) return { repeated: true };
    if (!answered(entry)) return { empty: true };
    const value = answerIn(entry, key);
    return value === null ? { unreadable: true } : { value };
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
    const scope = element.form || closestAcross(element, 'form') || rootOf(element);
    const password = deepQueryAll(doc, 'input[type="password"]').some(box => rendered(box) && (scope === doc || scope === rootOf(box) || scope.contains(box) || closestAcross(box, 'form') === scope));
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
    return [...new Set((Array.isArray(keys) ? keys : []).flatMap(key => key === 'applicantIowaResident' ? ['iowaResident'] : SOURCES[key] || [key]))]
      .filter(key => PROFILE_KEYS.includes(key) || ruleOnlyKey(key) || key === 'iowaResident');
  }
  const cents = value => /^\d{1,8}(\.\d{1,2})?$/.test(String(value || '')) ? Math.round(Number(value) * 100) : null;
  const dollars = amount => amount % 100 ? (amount / 100).toFixed(2) : String(amount / 100);
  function deriveValues(values) {
    const result = { ...(values || {}) };
    if (['yes', 'no'].includes(values?.iowaResident)) result.applicantIowaResident = values.iowaResident;
    else delete result.applicantIowaResident;
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
    // The saved benefits list is everything the household gets now (#184): a benefit left off an answered list is a No.
    const benefits = String(values?.currentBenefits || '').split(',').filter(Boolean);
    for (const [code, key] of Object.entries(BENEFIT_KEYS)) { if (benefits.length) result[key] = benefits.includes(code) ? 'yes' : 'no'; else delete result[key]; }
    return result;
  }

  function setValue(element, value) {
    const win = element.ownerDocument.defaultView;
    const prototype = element.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
    return element.value === value;
  }
  function chooseOption(options, key, value) {
    const wanted = normal(value);
    if (answerKind(key) === 'yesno') return options.findIndex(option => new RegExp(`^${wanted}\\b`).test(normal(option)));
    if (answerKind(key) === 'one') { const { picks, ambiguous } = chosenOptions(key, options, value); return !ambiguous && picks.length === 1 ? picks[0] : -1; }
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
  // A saved value as the box takes it. Null when the box asks for more than one date order: which it wants can't be told.
  function formatted(key, value, entry) {
    const element = entry.elements[0];
    const text = String(value);
    if (key === 'birthDate' || key === TODAY_KEY) {
      const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      if (!date) return null;
      const [, year, month, day] = date;
      // A split date's box takes its own part (#258).
      const part = key === TODAY_KEY ? todayAsked(entry) : 'date';
      if (part !== 'date') return { year, month, day }[part] ?? null;
      if (element.type === 'date') return text;
      // In the order the box asks for (#156); month first when it doesn't say, as US forms write it.
      const orders = dateOrders(entry);
      if (orders.size > 1) return null;
      return orders.has('year') ? `${year}-${month}-${day}` : orders.has('day') ? `${day}/${month}/${year}` : `${month}/${day}/${year}`;
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
    if (entry.kind === 'editable') return writeEditable(first, value);
    if (['ariaCombo', 'ariaListbox', 'ariaCheckbox', 'ariaSwitch'].includes(entry.kind)) return fillAria(entry, value, key);
    if (entry.kind === 'input' || entry.kind === 'textarea') {
      const text = formatted(key, value, entry);
      if (text === null || (first.maxLength > 0 && text.length > first.maxLength)) return false;
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
    if (entry.kind === 'checkbox' && entry.elements.length > 1 && answerKind(key) === 'several') {
      const { picks, ambiguous } = chosenOptions(key, optionsOf(entry), value);
      if (!picks.length) return false;
      for (const index of picks) entry.elements[index].click();
      if (!picks.every(index => entry.elements[index].checked)) return false;
      if (ambiguous) answeredInPart.set(first, picks.map(index => entry.elements[index]));
      return true;
    }
    if (entry.kind === 'checkbox' && entry.elements.length === 1 && answerKind(key) === 'yesno') {
      if (value !== 'yes') return false;
      first.click();
      return first.checked;
    }
    return false;
  }
  // Bind labels, ownership and option identities to the preview. Only the unchanged, still
  // unanswered entry can receive a saved answer; another person's new field cannot reuse its id.
  function binding(entry) {
    const first = entry.elements[0], form = first.form || closestAcross(first, 'form');
    const options = entry.kind === 'select' ? Array.from(first.options) : ['ariaCombo', 'ariaListbox'].includes(entry.kind) ? listboxOptions(listboxFor(entry)) : [];
    return { root: rootOf(first), form, options,
      state: JSON.stringify({ labels: entry.labels, invalidLabels: entry.invalidLabels, field: fieldOf(entry), form: form && [form.id, form.getAttribute('action'), form.getAttribute('method')],
        controls: entry.elements.map(element => ['id', 'name', 'type', 'role', 'autocomplete', 'aria-label', 'aria-labelledby', 'aria-controls', 'aria-owns', 'contenteditable', 'maxlength', 'pattern', 'min', 'max', 'step', 'value'].map(name => element.getAttribute(name))),
        options: options.map(option => [optionText(option), option.value, ariaOptionText(option), option.getAttribute('data-value'), option.disabled, option.getAttribute('aria-disabled')]) }) };
  }
  function sameBinding(entry, fresh) {
    if (!fresh || fresh.kind !== entry.kind) return false;
    const saved = entry.binding, now = binding(fresh);
    return saved && saved.root === now.root && saved.form === now.form && saved.state === now.state && saved.options.length === now.options.length && saved.options.every((option, index) => option === now.options[index]);
  }
  const sameElements = (entry, other) => entry.elements.length === other.elements.length && entry.elements.every((element, index) => element === other.elements[index]);
  const entryUsable = entry => entry.elements.every(element => element.isConnected && (entry.kind === 'editable' ? editableUsable(element) : ARIA_TYPES[entry.kind] ? ariaUsable(element) : eligible(element)));
  const exactText = value => String(value).trim().replace(/\s+/g, ' ').toLowerCase();
  function uniqueIndex(options, value, key) {
    if (key) {
      const index = chooseOption(options, key, value);
      if (index < 0) return -1;
      // Duplicate or overlapping interpretations do not choose whichever happens to come first.
      return options.filter(option => chooseOption([option], key, value) === 0).length === 1 ? index : -1;
    }
    const indexes = options.map((option, index) => exactText(option) === exactText(value) ? index : -1).filter(index => index >= 0);
    return indexes.length === 1 ? indexes[0] : -1;
  }
  const unsafeValue = (value, multiline) => UNSEEN.test(multiline ? value.replace(/[\r\n\t]/g, '') : value);
  function writeEditable(element, value) {
    if (!editableUsable(element) || typeof value !== 'string' || !value.trim() || value.length > 1000 || unsafeValue(value, element.getAttribute('aria-multiline') !== 'false')) return false;
    element.textContent = value; // text, never HTML supplied by a saved answer
    const win = element.ownerDocument.defaultView;
    element.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
    return element.textContent === value;
  }
  function fillAria(entry, value, key) {
    const first = entry.elements[0];
    if (['ariaCheckbox', 'ariaSwitch'].includes(entry.kind)) {
      if (entry.elements.length === 1) {
        const wanted = exactText(value);
        if (!['yes', 'no'].includes(wanted) || first.getAttribute('aria-checked') !== 'false') return false;
        if (wanted === 'no') { explicitNo.set(first, 'false'); return true; }
        first.click();
        return first.getAttribute('aria-checked') === 'true' || { pending: first };
      }
      const index = uniqueIndex(entry.elements.map(ariaOptionText), value, key);
      if (index < 0 || entry.elements.some(element => element.getAttribute('aria-checked') !== 'false')) return false;
      const option = entry.elements[index]; option.click();
      return option.getAttribute('aria-checked') === 'true' || { pending: option };
    }
    const list = listboxFor(entry), options = listboxOptions(list), index = uniqueIndex(options.map(ariaOptionText), value, key);
    if (!list || index < 0 || options.some(option => !['true', 'false'].includes(option.getAttribute('aria-selected')))) return false;
    const option = options[index];
    if (option.getAttribute('aria-disabled') === 'true') return false;
    if (entry.kind === 'ariaCombo' && !rendered(list)) {
      if (first.getAttribute('aria-expanded') !== 'false') return false;
      const before = binding(entry);
      first.click();
      // Only use the previewed option list, and only if the page actually opened it.
      const fresh = listboxOptions(list);
      const rechecked = questionsOn(first.ownerDocument).find(candidate => sameElements(entry, candidate));
      if (fresh.length !== options.length || !fresh.every((item, i) => item === options[i]) || uniqueIndex(fresh.map(ariaOptionText), value, key) !== index || answered(entry) || !sameBinding({ ...entry, binding: before }, rechecked)) return false;
    }
    if (!rendered(option) || option.getAttribute('aria-disabled') === 'true') return false;
    option.click();
    return option.getAttribute('aria-selected') === 'true' || { pending: option, attribute: 'aria-selected' };
  }
  // Custom answers are explicit saved facts. They cannot override a standard saved-field match,
  // or provide a route around protected questions and person scopes.
  function canCustom(field) {
    return Boolean(field && layaText(field.label, 200) && !unsafeQuestion(field) && !protectedCustom(field) && !blockedSuggestion(field.label) && !iowaRule(field.label) &&
      ['text', 'textarea', 'number', 'date', 'email', 'tel', 'select', 'radio', 'checkbox'].includes(field.type) && Array.isArray(field.options) && field.options.length <= 30 &&
      field.options.every(option => layaText(option, 100)) && new Set(field.options.map(exactText)).size === field.options.length);
  }
  function fillCustom(entry, value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 1000 || unsafeValue(value, entry.kind === 'textarea' || (entry.kind === 'editable' && entry.elements[0].getAttribute('aria-multiline') !== 'false'))) return false;
    const first = entry.elements[0];
    if (entry.kind === 'editable') return writeEditable(first, value);
    if (['ariaCombo', 'ariaListbox', 'ariaCheckbox', 'ariaSwitch'].includes(entry.kind)) return fillAria(entry, value);
    if (['select', 'radio', 'ariaRadio'].includes(entry.kind) || (entry.kind === 'checkbox' && entry.elements.length > 1)) {
      const options = optionsOf(entry), index = uniqueIndex(options, value);
      if (entry.kind === 'select') {
        const target = Array.from(first.options).filter(option => option.value)[index];
        if (!target || target.disabled || target.parentElement.disabled) return false;
      }
      return index >= 0 && fillOption(entry, options[index]);
    }
    if (entry.kind === 'checkbox') {
      if (exactText(value) === 'no') { explicitNo.set(first, 'false'); return true; }
      if (exactText(value) !== 'yes') return false;
      first.click(); return first.checked;
    }
    if (!['input', 'textarea'].includes(entry.kind) || (first.maxLength > 0 && value.length > first.maxLength)) return false;
    if (first.type === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) return false;
    if (first.type === 'date') {
      const date = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
    }
    const probe = first.cloneNode(false); probe.value = value;
    if (typeof probe.checkValidity === 'function' && !probe.checkValidity()) return false;
    return setValue(first, value);
  }
  // Remember for next time (#186): the questions the side panel may offer to keep the applicant's answer to, as a custom
  // answer. Only one a custom answer may fill, in a box that holds one answer, within a custom answer's limits, and never a
  // search box. A checkbox group can hold several answers and a lone checkbox is often consent, so neither is offered.
  const REMEMBER_TYPES = Object.freeze(['text', 'textarea', 'number', 'date', 'email', 'tel', 'radio', 'select']);
  const canRemember = field => canCustom(field) && REMEMBER_TYPES.includes(field.type) && field.label.length <= 120 && !SEARCH.test(normal(field.label)) &&
    (['radio', 'select'].includes(field.type) ? field.options.length > 0 : field.options.length === 0);
  // Answers that change over time start unchecked: a date box, and questions or choices about dates, times, days, pickups,
  // appointments, deliveries, visits, and this week or month, in English and Spanish.
  const TIME_BOUND = /\b(dates?|times?|when|today|tonight|tomorrow|yesterday|now|currently|days?|weekly|weeks?|weekends?|months?|monthly|years?|yearly|visits?|appointments?|pick ?ups?|deliver(y|ies)|schedul\w*|slots?|hours?|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december|fecha|hora|hoy|manana|semana|mes|cita|visita|recogida|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b|\b\d{1,2}( \d{2})? ?(a ?m|p ?m)\b/;
  const timeBound = field => field.type === 'date' || [field.label, ...field.options].some(text => TIME_BOUND.test(normal(text)));
  // After the applicant's click, the answer in one question of the current plan the rules left open, as the page shows it: a
  // box's words, or the chosen option's own text. Only a question canRemember offers, never a password, code, signature,
  // consent, payment or another person's box. Null when it may not be read; { empty } when it holds no answer; { unreadable }
  // when its answer can't be kept as it is; { repeated } when the page asks the same question in more than one box.
  const REMEMBER_KINDS = Object.freeze(['input', 'textarea', 'editable', 'select', 'radio', 'ariaRadio', 'ariaListbox', 'ariaCombo']);
  function chosenAnswer(entry) {
    const first = entry.elements[0];
    const chosen = entry.kind === 'select' ? Array.from(first.selectedOptions).find(option => option.value)
      : entry.kind === 'radio' ? entry.elements.find(element => element.checked)
        : entry.kind === 'ariaRadio' ? entry.elements.find(element => element.getAttribute('aria-checked') === 'true')
          : ['ariaListbox', 'ariaCombo'].includes(entry.kind) ? listboxOptions(listboxFor(entry)).find(option => option.getAttribute('aria-selected') === 'true') : null;
    if (entry.kind === 'editable') return first.textContent.trim();
    if (entry.kind === 'select') return chosen ? clean(chosen.textContent) || chosen.value : '';
    if (entry.kind === 'radio') return chosen ? optionText(chosen) : '';
    if (['ariaRadio', 'ariaListbox', 'ariaCombo'].includes(entry.kind)) return chosen ? ariaOptionText(chosen) : '';
    return String(first.value || '').trim();
  }
  function readOpen(doc, token, id) {
    if (!current || current.token !== token || current.doc !== doc) return null;
    const entry = current.map.get(id);
    const fresh = entry && questionsOn(doc).find(candidate => sameElements(entry, candidate));
    if (!fresh || !REMEMBER_KINDS.includes(fresh.kind) || !entryUsable(fresh) || fresh.invalidLabels || match(fresh).key) return null;
    const field = fieldOf(fresh);
    const identity = [...fresh.labels, ...fresh.elements.map(element => `${element.id} ${element.getAttribute('name') || ''} ${element.getAttribute('autocomplete') || ''}`)].join(' ');
    if (!canRemember(field) || besideForm(fresh, doc) || protectedCustom({ label: identity, options: field.options })) return null;
    const asked = question(field.label), choices = field.options.map(normal).sort().join('|');
    const same = other => { const seen = fieldOf(other); return seen.type === field.type && question(seen.label) === asked && seen.options.map(normal).sort().join('|') === choices; };
    if (questionsOn(doc).filter(same).length > 1) return { repeated: true };
    if (!answered(fresh)) return { empty: true };
    const value = chosenAnswer(fresh);
    const multiline = field.type === 'textarea';
    const keepable = value && value.length <= 1000 && !unsafeValue(value, multiline) && (multiline || !/[\r\n]/.test(value)) &&
      (!field.options.length || field.options.filter(option => option === value).length === 1);
    return keepable ? { value } : { unreadable: true };
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
  // A rule's answer has a solid green outline, a guess a dashed amber one, and Laya's best guess (#185) a dotted plum one.
  function ensureStyle(doc, scope = doc) {
    if (scope.querySelector('#secondhand-filled-style')) return;
    const style = doc.createElement('style');
    style.id = 'secondhand-filled-style';
    style.textContent = '[data-secondhand-filled="rule"]{outline:2px solid #5f9b62!important;outline-offset:1px!important}[data-secondhand-filled="guess"]{outline:2px dashed #d99a2b!important;outline-offset:1px!important}' +
      '[data-secondhand-filled="laya-guess"]{outline:3px dotted #9b3d8f!important;outline-offset:2px!important}' +
      '[data-secondhand-attention]{outline:3px solid #d99a2b!important;outline-offset:3px!important;box-shadow:0 0 0 7px #d99a2b40!important}';
    (scope === doc ? doc.head || doc.documentElement : scope).append(style);
  }
  function rejectedByPage(entry) {
    const container = entry.elements[0].closest('.form-line');
    return entry.elements.some(element => element.getAttribute('aria-invalid') === 'true') || container?.classList.contains('form-line-error') ||
      Boolean(container && Array.from(container.querySelectorAll('[role="alert"]')).some(rendered));
  }
  // Laya's best guess (#185) goes only to a single-choice question, never a checkbox group, and never on Iowa's portal.
  const LAYA_GUESS_KINDS = Object.freeze(['radio', 'ariaRadio', 'select']);
  const layaGuessable = (doc, entry) => LAYA_GUESS_KINDS.includes(entry.kind) && doc.location.origin !== 'https://hhsservices.iowa.gov';
  // Laya's best guesses on this page, by the id each was filled under: answered questions leave the next plan, but the
  // side panel lists each one for the applicant to find and check.
  let layaGuessed = null;
  // `kind` is 'rule', 'guess', or 'laya-guess'.
  function mark(doc, entry, kind, id) {
    entry.elements.forEach(element => ensureStyle(doc, rootOf(element)));
    entry.elements.forEach(element => element.setAttribute('data-secondhand-filled', kind));
    if (kind !== 'laya-guess') return;
    if (layaGuessed?.doc !== doc) layaGuessed = { doc, map: new Map() };
    layaGuessed.map.set(id, entry);
  }
  function fillFields(doc, token, assignments, values) {
    const ids = (Array.isArray(assignments) ? assignments : []).map(item => item?.id);
    if (!current || current.token !== token || current.doc !== doc) return { ok: false, filled: [], skipped: ids, rejected: [], pending: [], partial: [] };
    const filled = [], skipped = [], rejected = [], pending = [], partial = [];
    current.pending = new Map();
    for (const assignment of assignments) {
      const entry = current.map.get(assignment?.id);
      const key = assignment?.key;
      const custom = assignment?.custom === true;
      const value = values?.[custom ? assignment.id : key];
      const fresh = entry && questionsOn(doc).find(candidate => sameElements(entry, candidate));
      const usable = entry && !answered(entry) && entryUsable(entry) && sameBinding(entry, fresh) && !fresh.invalidLabels &&
        (!(custom || entry.kind === 'editable' || ['ariaCombo', 'ariaListbox', 'ariaCheckbox', 'ariaSwitch'].includes(entry.kind)) ||
          (!besideForm(fresh, doc) && !protectedCustom({ label: [...fresh.labels, ...fresh.elements.map(element => `${element.id} ${element.getAttribute('name') || ''} ${element.getAttribute('autocomplete') || ''}`)].join(' '), options: optionsOf(fresh) }))) &&
        (!IOWA_KEYS.includes(key) || (['yes', 'no'].includes(value) && entry.iowaState && match(fresh).key === key && entry.iowaState === iowaEntryState(fresh)));
      // An option Laya picked from the saved profile is always a guess, and never for a question only the applicant answers.
      const option = assignment?.option;
      const answering = typeof option === 'string' && key === undefined;
      const layaGuess = answering && assignment.layaGuess === true;
      // A key the rules did not choose for this question is a guess: never for a question only the applicant
      // answers, by any of its labels, and only a key a guess may offer.
      const allowed = entry && (match(entry).key === key || (!householdRulesOnly(doc) && !applicantOnly(entry) && canSuggest(key, { label: entry.labels[0] || '' })));
      const placed = !usable ? false
        : custom ? key === undefined && option === undefined && assignment.guessed !== true && assignment.layaGuess !== true && !householdRulesOnly(doc) && !fresh.invalidLabels && !match(fresh).key && canCustom(fieldOf(fresh)) && fillCustom(fresh, value)
        : answering ? !householdRulesOnly(doc) && !applicantOnly(entry) && !entry.labels.some(iowaRule) && (!layaGuess || layaGuessable(doc, entry)) && fillOption(entry, option)
        : option === undefined && (GENERIC_KEYS.includes(key) || COMPOSITE_KEYS.includes(key) || ruleOnlyKey(key)) && allowed && typeof value === 'string' && value && compatible(key, entry) && fillEntry(entry, key, value);
      if (!placed) { skipped.push(assignment?.id); continue; }
      const kind = layaGuess ? 'laya-guess' : answering || assignment.guessed || GUESS_KEYS.includes(key) ? 'guess' : 'rule';
      if (placed.pending) { current.pending.set(assignment.id, { option: placed.pending, attribute: placed.attribute || 'aria-checked', entry, kind }); pending.push(assignment.id); continue; }
      entry.elements[0].dispatchEvent(new entry.elements[0].ownerDocument.defaultView.Event('blur'));
      if (rejectedByPage(entry)) {
        if (entry.kind === 'input' || entry.kind === 'textarea' || entry.kind === 'select') setValue(entry.elements[0], '');
        rejected.push(assignment.id); continue;
      }
      mark(doc, entry, kind, assignment.id);
      filled.push(assignment.id);
      if (inPart(entry)) partial.push(assignment.id);
    }
    return { ok: true, filled, skipped, rejected, pending, partial };
  }
  // Waits for the choices fillFields left pending to show as checked. One the page never
  // checks (or a stale plan's) is reported as skipped; only confirmed choices count as filled.
  // A document without a window was left behind by a page change: the wait stops there, and
  // the fill is reported as interrupted, with nothing on it confirmed.
  async function settle(doc, token, result, { timeoutMs = 500 } = {}) {
    if (!result?.pending?.length) return result;
    const live = current && current.token === token && current.doc === doc ? current.pending : new Map();
    const checked = id => { const item = live.get(id); return Boolean(current?.doc === doc && current.token === token && item?.option.isConnected && item.option.getAttribute(item.attribute) === 'true'); };
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
      else { mark(doc, item.entry, item.kind, id); settled.filled.push(id); }
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
    const entry = (current?.doc === doc ? current.map.get(id) : null) || (listed?.doc === doc ? listed.map.get(id) : null) || (layaGuessed?.doc === doc ? layaGuessed.map.get(id) : null);
    const element = entry?.elements[0];
    if (!element || !element.isConnected || !rendered(element)) return false;
    clearAttention();
    const targets = attentionTargets(entry, doc);
    targets.forEach(target => ensureStyle(doc, rootOf(target)));
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

  // Internal DOM records for the navigation guard. No answer values or DOM references are
  // serialized to the worker; unsupported visible controls remain explicit blockers.
  function navigationFields(doc) {
    const entries = questionsOn(doc), covered = new Set(entries.flatMap(entry => entry.elements));
    const fields = entries.map(entry => ({ elements: [...entry.elements, ...(entry.kind === 'ariaCombo' && listboxFor(entry) ? [listboxFor(entry)] : [])], answered: answered(entry) && !inPart(entry), required: fieldOf(entry).required,
      safe: !entry.invalidLabels && !applicantOnly(entry) && !protectedCustom(fieldOf(entry)) && !entry.labels.some(otherPersonQuestion) && !besideForm(entry, doc), supported: true }));
    for (const control of deepQueryAll(doc, 'input,select,textarea,[contenteditable],[role="textbox"],[role="radio"],[role="checkbox"],[role="switch"],[role="combobox"],[role="listbox"],[role="slider"],[role="spinbutton"]')) {
      if (covered.has(control) || !rendered(control) || control.disabled || control.getAttribute('aria-disabled') === 'true' || control.type === 'hidden' || ['submit', 'button', 'reset', 'image'].includes(control.type)) continue;
      // The popup list of an already represented combobox is part of that one control.
      if (entries.some(entry => entry.kind === 'ariaCombo' && listboxFor(entry) === control)) continue;
      fields.push({ elements: [control], answered: false, required: control.required === true || control.getAttribute('aria-required') === 'true', safe: false, supported: false });
    }
    return fields;
  }

  const api = Object.freeze({ GENERIC_KEYS, PROFILE_KEYS, SAVE_KEYS, GUESS_KEYS, MEMBER_KEYS, IOWA_KEYS, CHOICE_KEYS, answeredIds, readAnswer, UNSAFE_QUESTION, OTHER_PERSON_ROLE, MEMBER_DETAIL, CHILD_ROLE, PERSON_DETAIL,
    COMBINED_ADDRESS_QUESTION, PERSON_NOT_AMOUNT, blockedSuggestion, isBandKey, plan, offers, questions, requestKeys, deriveValues, fillFields, settle, focusField, elementFor,
    canSuggest, canCustom, canRemember, timeBound, readOpen, unsafeQuestion, layaQuestion, deepQueryAll, isRendered: rendered, navigationFields });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandGeneric = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

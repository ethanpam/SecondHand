(function (root, factory) {
  'use strict';
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  else root.SecondHandSnapInformation = catalog;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Local answers only. Empty means unanswered, never No. This catalog grants
  // no page access and contains no consent, signature, credential, or submit fields.
  const yesno = [['', 'Unanswered'], ['yes', 'Yes'], ['no', 'No']];
  const field = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...(type === 'yesno' ? { options: yesno } : {}), ...extra });
  const yn = pairs => pairs.map(([key, label]) => field(key, label, 'yesno'));
  const frequencies = [['', 'Unanswered'], ...['Hourly', 'Weekly', 'Every Other Week', 'Twice a Month', 'Monthly', 'Quarterly', 'Semi Annually', 'Annually', 'Irregular/Infrequent', 'One time'].map(value => [value, value])];
  const sections = [
    { id: 'ssn-card', label: 'Name on your Social Security card', description: 'Enter exactly what your card says. These fields do not change your other saved names.', fields: [
      field('ssnCardFirstName', 'First name on Social Security card', 'text', { maxLength: 100 }),
      field('ssnCardMiddleName', 'Middle name on Social Security card', 'text', { maxLength: 100 }),
      field('ssnCardLastName', 'Last name on Social Security card', 'text', { maxLength: 100 })
    ] },
    { id: 'background', label: 'Your background', description: 'Answer for yourself. Home state does not establish birthplace, citizenship, or residency.', fields: [
      ...yn([['iowaResident', 'You are an Iowa resident'], ['bornInUs', 'You were born in the United States'], ['naturalizedCitizen', 'You are a naturalized U.S. citizen']]),
      field('birthState', 'U.S. state of birth', 'state'), field('preferredLanguage', 'Preferred language'),
      field('needsInterpreter', 'You need an interpreter', 'yesno'), field('ethnicity', 'Your ethnicity (your own description)'), field('race', 'Your race or races (your own description)'),
      ...yn([['eatsWithHousehold', 'You purchase and prepare meals with this household'], ['pregnant', 'You are pregnant'], ['migrantSeasonalFarmworker', 'You are a migrant or seasonal farmworker']]),
      field('immigrationStatus', 'Your immigration or lawful-presence status (as documented)'), field('pregnancyDueDate', 'Expected due date', 'date')
    ] },
    { id: 'emergency', label: 'Emergency SNAP screening', description: 'Save your answers to the household questions. No answer is calculated from saved money or employment details.', fields: yn([
      ['emergencyIncomeUnder150', 'Household income is less than $150 this month'], ['emergencyCashUnder100', 'Household cash, checking, and savings total less than $100'],
      ['emergencyMigrantSeasonal', 'Household includes a migrant or seasonal farmworker'], ['emergencyHousingExceedsIncome', 'Housing and utility expenses exceed expected income and available money (check the portal question)']
    ]) },
    { id: 'work-screening', label: 'Household job and school questions', fields: yn([
      ['householdInSchool', 'Anyone in the household attends school or college'], ['householdOnStrike', 'Anyone in the household is on strike'],
      ['householdWorking', 'Anyone works, expects to work, or is self-employed'], ['householdJobEnded30Days', 'Anyone ended a job in the last 30 days']
    ]) },
    { id: 'income-screening', label: 'Household other-income questions', description: 'Use the portal’s complete question when answering each grouped topic. These answers are not inferred from tax statements.', fields: yn([
      ['incomeSocialSecurityRetirement', 'Household receives Social Security, retirement, or pension income'],
      ['incomeSupportInvestmentsUnemployment', 'Household receives listed support, investment, unemployment, or similar income'],
      ['incomeGiftsWorkersCompSsi', 'Household receives listed gifts, workers’ compensation, settlement, SSI, or similar income'],
      ['incomeEducationGrantsLoans', 'Household receives educational grants or loans'], ['incomeInKindSupport', 'Household receives housing, food, or other support free or in exchange'],
      ['incomeExpectedUnchanged', 'Household expects income to remain unchanged'], ['incomeFriendsRelatives', 'Household receives money from friends or relatives'], ['incomeOther', 'Household receives other income']
    ]) },
    { id: 'expense-screening', label: 'Household expense questions', fields: yn([
      ['paysDependentCare', 'Household pays dependent-care expenses'], ['paysHousing', 'Household pays housing expenses'], ['lowRentHousing', 'Household lives in low-rent or subsidized housing'],
      ['paysChildSupport', 'Household pays child support'], ['paysUtilities', 'Household pays utilities'], ['receivedEnergyAssistance', 'Household received energy assistance in the past year'],
      ['paysMedical', 'Household pays medical expenses'], ['paysMedicare', 'Household pays Medicare expenses']
    ]) },
    { id: 'utilities', label: 'Utility types paid by the household', description: 'Each type is an explicit answer. A monthly total does not establish which utilities you pay.', fields: yn([
      ['utilityGas', 'Gas'], ['utilityElectricity', 'Electricity or lights'], ['utilityWaterSewage', 'Water or sewage'], ['utilityTelephone', 'Telephone'],
      ['utilityPetFees', 'Pet fees'], ['utilityGarageRent', 'Garage rent'], ['utilityLandlordExtra', 'Extra charges from landlord'], ['utilityGarbage', 'Garbage'], ['utilityHeatingCooling', 'Heating or cooling']
    ]) },
    { id: 'property-screening', label: 'Household property questions', fields: yn([
      ['hasLiquidAssets', 'Household has cash, checking, savings, or other liquid assets'], ['hasRealProperty', 'Household owns real property'], ['hasTrust', 'Household has a trust'],
      ['transferredProperty90Days', 'Household sold or transferred property in the last 90 days'], ['hasPersonalProperty', 'Household has other personal property'], ['hasVehicle', 'Household owns a vehicle'],
      ['sharesResourcesOutsideHousehold', 'Household shares resources with someone outside the household']
    ]) },
    { id: 'other-screening', label: 'Other household questions', description: 'These are sensitive question topics, not legal conclusions. Compare each with the full portal wording and leave uncertain answers blank.', fields: yn([
      ['agedOutFosterCare', 'Anyone in the household aged out of foster care'], ['householdHomeless', 'Anyone in the household is homeless'],
      ['snapDisqualified', 'Anyone in the household is disqualified from SNAP'], ['hasIowaEbt', 'Anyone in the household has an Iowa EBT card'],
      ['householdIncarcerated', 'Anyone in the household is incarcerated'], ['hasAuthorizedRepresentative', 'You want an authorized representative'],
      ['benefitsAnotherState', 'Anyone in the household receives benefits from another state'],
      ['fugitiveFelon', 'Anyone is fleeing to avoid prosecution or custody for a felony (check the full question)'],
      ['probationParoleViolation', 'Anyone is violating probation or parole (check the full question)'],
      ['snapSaleOver500', 'Anyone has a finding involving selling $500 or more in SNAP benefits (check the full question)'],
      ['duplicateBenefits', 'Anyone has a finding involving duplicate benefits (check the full question)'],
      ['snapTradingDrugs', 'Anyone has a finding involving trading SNAP for controlled substances (check the full question)'],
      ['snapTradingWeapons', 'Anyone has a finding involving trading SNAP for firearms, ammunition, or explosives (check the full question)']
    ]) },
    { id: 'helpers', label: 'Application helper and representative', description: 'Contact details do not authorize anyone, sign a form, or provide consent.', fields: [
      field('helperName', 'Application helper’s name'), field('helperOrganization', 'Helper’s organization'), field('helperRelationship', 'Helper’s relationship to you'),
      field('helperPhone', 'Helper’s phone', 'tel'), field('helperEmail', 'Helper’s email', 'email'),
      field('helperAddressLine1', 'Helper’s street address'), field('helperAddressLine2', 'Helper’s apartment or unit'), field('helperCity', 'Helper’s city'),
      field('helperState', 'Helper’s state', 'state'), field('helperZip', 'Helper’s ZIP code', 'zip'),
      field('representativeName', 'Authorized representative’s name'), field('representativeOrganization', 'Representative’s organization'), field('representativeRelationship', 'Representative’s relationship to you'),
      field('representativePhone', 'Representative’s phone', 'tel'), field('representativeEmail', 'Representative’s email', 'email'),
      field('representativeAddressLine1', 'Representative’s street address'), field('representativeAddressLine2', 'Representative’s apartment or unit'),
      field('representativeCity', 'Representative’s city'), field('representativeState', 'Representative’s state', 'state'), field('representativeZip', 'Representative’s ZIP code', 'zip')
    ] }
  ];
  const person = () => field('person', 'Person this belongs to', 'text', { hint: 'Enter the exact person. This is never inferred from household membership or a document name.' });
  const amount = () => field('amount', 'Amount', 'money');
  const frequency = () => field('frequency', 'How often', 'select', { options: frequencies });
  const dates = () => [field('startDate', 'Start date', 'date'), field('endDate', 'End date', 'date')];
  const records = [
    { key: 'jobs', label: 'Jobs and self-employment', fields: [person(), field('employer', 'Employer or business name'), field('jobTitle', 'Job or work description'), field('selfEmployed', 'Self-employed', 'yesno'), field('employerPhone', 'Employer phone', 'tel'), field('employerAddress', 'Employer address'), amount(), frequency(), field('hoursPerWeek', 'Hours per week'), ...dates(), field('lastPayDate', 'Last pay date', 'date'), field('lastPayAmount', 'Last pay amount', 'money'), field('reasonEnded', 'Reason work ended')] },
    { key: 'otherIncomeSources', label: 'Other income sources', fields: [person(), field('type', 'Income type'), field('source', 'Payer or source'), amount(), frequency(), ...dates(), field('expectedChange', 'Expected change (your own description)')] },
    { key: 'housingExpenses', label: 'Housing expenses', fields: [person(), field('type', 'Housing expense type'), field('paidTo', 'Paid to'), amount(), frequency(), ...dates()] },
    { key: 'dependentCareExpenses', label: 'Dependent-care expenses', fields: [person(), field('dependent', 'Person receiving care'), field('provider', 'Care provider'), field('providerPhone', 'Provider phone', 'tel'), field('reason', 'Reason for care'), amount(), frequency(), ...dates()] },
    { key: 'childSupportExpenses', label: 'Child-support expenses', fields: [person(), field('recipient', 'Person receiving payment'), field('child', 'Child this supports'), field('courtOrdered', 'Court ordered', 'yesno'), amount(), frequency(), ...dates()] },
    { key: 'medicalExpenses', label: 'Medical and Medicare expenses', fields: [person(), field('type', 'Expense type'), field('provider', 'Provider or insurer'), amount(), frequency(), field('expenseDate', 'Expense date', 'date'), field('reimbursedAmount', 'Amount reimbursed', 'money')] },
    { key: 'assets', label: 'Assets and property', fields: [person(), field('type', 'Asset type'), field('description', 'Asset description'), field('currentValue', 'Current value', 'money'), field('amountOwed', 'Amount owed', 'money'), field('institution', 'Bank or institution'), field('accountOrPolicy', 'Account or policy reference'), field('acquiredDate', 'Date acquired', 'date'), field('sharedWith', 'Other owner or person sharing this asset'), field('ownershipShare', 'Ownership share (your own description)')] },
    { key: 'expenseContributions', label: 'Help paying household expenses', fields: [person(), field('contributor', 'Person or organization contributing'), field('expenseType', 'Expense being paid'), amount(), frequency(), field('paidDirectly', 'Paid directly to the provider', 'yesno'), ...dates()] },
    { key: 'taxStatements', label: 'Historical tax statements', description: 'Historical source details only. Never treated as current employment or converted to monthly income.', fields: [
      field('documentType', 'Document type', 'select', { options: [['', 'Unanswered'], ...['1040', '1040-sr', 'w2', 'ssa-1099', '1099-nec'].map(value => [value, value])] }),
      field('taxYear', 'Tax year'), field('sourceName', 'Employer, payer, issuer, or taxpayer name'),
      field('sourceRole', 'Source role', 'select', { options: [['', 'Unanswered'], ...['employer', 'payer', 'issuer', 'taxpayer'].map(value => [value, value])] }),
      field('recipientName', 'Recipient or taxpayer name'), field('annualIncome', 'Historical annual amount', 'money'), field('annualIncomeLabel', 'Income line or box label'),
      field('annualWithholding', 'Historical annual withholding', 'money'), field('annualWithholdingLabel', 'Withholding line or box label')
    ] }
  ];
  const memberFields = [
    field('firstName', 'First name', 'text', { maxLength: 100 }), field('lastName', 'Last name', 'text', { maxLength: 100 }), field('birthDate', 'Date of birth', 'date'),
    field('relationship', 'Relationship to you', 'select', { options: [['', 'Unanswered'], ...['self', 'spouse-partner', 'child', 'parent', 'sibling', 'grandchild', 'other-relative', 'other'].map(value => [value, value])] }),
    field('student', 'Student', 'yesno'), field('grade', 'Grade', 'text', { maxLength: 20 }),
    field('middleName', 'Middle name', 'text', { maxLength: 100 }), field('isApplicant', 'Applying for benefits', 'yesno'), field('eatsWithHousehold', 'Purchases and prepares meals with this household', 'yesno'),
    field('hasSsnAnswer', 'Has a Social Security number', 'yesno'), field('ssn', 'Social Security number'), field('ssnCardNameMatches', 'Name matches Social Security card', 'yesno'),
    field('ssnCardFirstName', 'First name on Social Security card', 'text', { maxLength: 100 }), field('ssnCardMiddleName', 'Middle name on Social Security card', 'text', { maxLength: 100 }), field('ssnCardLastName', 'Last name on Social Security card', 'text', { maxLength: 100 }),
    field('usCitizen', 'U.S. citizen or national', 'yesno'), field('bornInUs', 'Born in the United States', 'yesno'), field('naturalizedCitizen', 'Naturalized U.S. citizen', 'yesno'),
    field('birthState', 'U.S. state of birth', 'state'), field('iowaResident', 'Iowa resident', 'yesno'), field('immigrationStatus', 'Immigration or lawful-presence status (as documented)'),
    field('pregnant', 'Pregnant', 'yesno'), field('pregnancyDueDate', 'Expected due date', 'date'), field('race', 'Race or races (person’s own description)'), field('ethnicity', 'Ethnicity (person’s own description)'),
    field('preferredLanguage', 'Preferred language'), field('needsInterpreter', 'Needs an interpreter', 'yesno'),
    field('sex', 'Sex', 'select', { options: [['', 'Unanswered'], ['Male', 'Male'], ['Female', 'Female']] }),
    field('maritalStatus', 'Marital status', 'select', { options: [['', 'Unanswered'], ...['Divorced', 'Legally Separated', 'Married (includes common-law)', 'Never Married', 'Separated', 'Widowed'].map(value => [value, value])] }),
    ...yn([['militaryOrVeteran', 'Military, veteran, or spouse of a veteran'], ['disabled', 'Disabled'], ['blind', 'Blind'], ['healthLimitation', 'Health condition limits daily activities, or lives in a medical facility'], ['medicare', 'Has Medicare']])
  ];
  const scalarFields = sections.flatMap(section => section.fields);
  function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  return freeze({ sections, scalarFields, records, memberFields, maxRecords: 20 });
});

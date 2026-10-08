'use strict';

const { PORTAL_URL, RECORD_FIELDS } = require('../shared/schema.cjs');

// A record is never a general profile field. Each release names a captured page,
// one local record type, and a bounded projection. Shared by the relay and app.
const REGISTRY = Object.freeze({
  'iowa-job-history': Object.freeze({
    url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, recordType: 'jobs', label: 'job',
    fields: Object.freeze(['person', 'workOrTraining', 'startDate', 'employer', 'jobTitle', 'monthlyHours', 'amount', 'frequency',
      'tipsOrCommissions', 'incomeExpectedSame', 'changedJobs30Days', 'stoppedWorking30Days', 'fewerHours30Days', 'selfEmployed',
      'selfEmploymentMonthlyNet', 'hasBusinessExpenses'])
  }),
  'iowa-retirement-income': Object.freeze({
    url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, recordType: 'otherIncomeSources', label: 'income',
    types: Object.freeze(['Private Pension', 'Social Security']), fields: Object.freeze(['person', 'type', 'amount', 'frequency'])
  }),
  'iowa-housing-expenses': Object.freeze({
    url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, recordType: 'housingExpenses', label: 'housing expense',
    types: Object.freeze(['Rent', 'Rent(Amount you are responsible to pay)']), fields: Object.freeze(['person', 'type', 'amount', 'frequency'])
  }),
  'iowa-utility-expenses': Object.freeze({
    url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, recordType: 'utilityExpenses', label: 'utility expense',
    fields: Object.freeze(['person', 'gas', 'electricity', 'waterSewage', 'telephone', 'petFees', 'garageRent', 'landlordExtra', 'garbage', 'heatingCooling'])
  }),
  'iowa-liquid-assets': Object.freeze({
    url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, recordType: 'assets', label: 'liquid asset',
    types: Object.freeze(['Cash/Uncashed Check']), fields: Object.freeze(['person', 'type', 'currentValue', 'amountOwed', 'accountOrPolicy', 'institution', 'acquiredDate'])
  })
});
const ALLOWED = new Set(['id', 'type', 'url', 'pageKey', 'recordType', 'fields', 'personName']);
const UNSEEN = /[[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]--[\u200C\u200D]]/v;
const safePerson = value => typeof value === 'string' && value.length <= 200 && !UNSEEN.test(value);
const normalizePerson = value => value.trim().replace(/\s+/gu, ' ').toLowerCase();

function recordRequestScope(request) {
  const scope = request && typeof request.pageKey === 'string' && Object.hasOwn(REGISTRY, request.pageKey) ? REGISTRY[request.pageKey] : null;
  if (!scope || request.type !== 'getRecordFields' || request.url !== scope.url || request.recordType !== scope.recordType ||
      Object.keys(request).some(key => !ALLOWED.has(key))) throw new Error('This Iowa page does not support the requested record.');
  const fields = request.fields;
  if (!Array.isArray(fields) || !fields.length || fields.length > scope.fields.length || !fields.includes('person') ||
      fields.some(field => typeof field !== 'string' || !scope.fields.includes(field)) || new Set(fields).size !== fields.length ||
      Object.keys(fields).length !== fields.length) throw new Error('Invalid requested record fields.');
  if (request.personName !== undefined && !safePerson(request.personName)) throw new Error('Invalid record owner.');
  return scope;
}

function candidatesFor(profile, request) {
  const scope = recordRequestScope(request);
  const person = normalizePerson(request.personName || '');
  return (Array.isArray(profile[request.recordType]) ? profile[request.recordType] : []).filter(record =>
    record && typeof record.id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.id) &&
    safePerson(record.person) && normalizePerson(record.person) && (!person || normalizePerson(record.person) === person) &&
    (!scope.types || (typeof record.type === 'string' && scope.types.includes(record.type.trim().replace(/\s+/gu, ' ')))));
}

const fieldLabel = (type, key) => RECORD_FIELDS[type]?.find(field => field.key === key)?.label || key;
// Labels stay in the desktop dialog. Strip invisible formatting for display only;
// never use the altered display string for owner matching or returned values.
const displayText = value => String(value || '').replace(new RegExp(UNSEEN.source, 'gv'), ' ').replace(/\s+/gu, ' ').trim().slice(0, 200);
function recordLabel(record, index, recordType = 'jobs') {
  if (recordType === 'assets') return `${index + 1}. ${displayText(record.person)} · ${displayText(record.type)}${record.institution ? ` · ${displayText(record.institution)}` : ''}${record.currentValue ? ` · Value ${displayText(record.currentValue)}` : ''}`;
  if (recordType === 'utilityExpenses') {
    const yes = REGISTRY['iowa-utility-expenses'].fields.filter(key => key !== 'person' && record[key] === 'yes').map(key => fieldLabel(recordType, key));
    return `${index + 1}. ${displayText(record.person)} · ${yes.length ? yes.join(', ') : 'No utilities marked Yes'}`;
  }
  if (recordType === 'otherIncomeSources' || recordType === 'housingExpenses') {
    const source = recordType === 'housingExpenses' ? record.paidTo : record.source;
    return `${index + 1}. ${displayText(record.person)} · ${displayText(record.type)}${source ? ` · ${displayText(source)}` : ''}${record.amount ? ` · ${displayText(record.amount)}${record.frequency ? ` / ${displayText(record.frequency)}` : ''}` : ''}`;
  }
  return `${index + 1}. ${displayText(record.person)} · ${displayText(record.employer) || 'Employer not recorded'} · ${displayText(record.jobTitle) || displayText(record.workOrTraining) || 'Job details not recorded'}${record.startDate ? ` (${displayText(record.startDate)})` : ''}${record.amount ? ` · Gross pay ${displayText(record.amount)}${record.frequency ? ` / ${displayText(record.frequency)}` : ''}` : ''}`;
}

module.exports = { REGISTRY, recordRequestScope, candidatesFor, normalizePerson, fieldLabel, recordLabel, displayText };

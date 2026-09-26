'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../extension/ai-mapper.js');

const UNREADABLE = 'The AI returned an unreadable answer.';
const MODEL_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }]
};

// Fictional descriptors. The extra `value`, `placeholder`, `name`, and
// `autocomplete` properties must never reach the model.
const SECRET_VALUES = ['Synthetic Applicant', 'synthetic@example.test', '515-555-0100', '123-45-6789', '4 kids'];
const fields = () => [
  { id: 'sh-1', label: 'Full name', type: 'text', options: [], value: SECRET_VALUES[0], name: 'applicant_full' },
  { id: 'sh-2', label: 'Email address', type: 'email', options: [], value: SECRET_VALUES[1], placeholder: 'you@example.test' },
  { id: 'sh-3', label: 'Number of children', type: 'number', options: [], value: SECRET_VALUES[4] },
  { id: 'sh-4', label: 'Is anyone in your household a veteran?', type: 'radio', options: ['Yes', 'No'] },
  { id: 'sh-5', label: 'State', type: 'select-one', options: ['Choose one', 'Iowa', 'Minnesota'] },
  { id: 'sh-6', label: 'Anything else we should know?', type: 'textarea', options: [], value: SECRET_VALUES[3], autocomplete: 'off' }
];
const happyAnswer = JSON.stringify({ 'sh-1': 'fullName', 'sh-2': 'email', 'sh-3': 'householdChildren', 'sh-4': 'householdVeteran', 'sh-5': 'state', 'sh-6': null });
const field = (type, options = []) => [{ id: 'f', label: 'Question', type, options }];
const accepts = (key, type, options) => ai.parseMapping(JSON.stringify({ f: key }), field(type, options)).mapping.f === key;

function model({ availability = 'available', answer = happyAnswer, prompt, create, availabilityError } = {}) {
  const calls = { availability: [], create: [], prompt: [], sessions: [] };
  const LanguageModel = {
    async availability(options) {
      calls.availability.push(options);
      if (availabilityError) throw availabilityError;
      return availability;
    },
    create(options) {
      calls.create.push(options);
      const session = {
        destroyed: 0,
        prompt(text, options) {
          calls.prompt.push({ text, options });
          return prompt ? prompt(text, options) : Promise.resolve(answer);
        },
        destroy() { session.destroyed++; }
      };
      calls.sessions.push(session);
      return create ? create(session, options) : Promise.resolve(session);
    }
  };
  return { LanguageModel, calls };
}
const never = () => new Promise(() => {});

test('the default allowlist is the fixed set of profile keys', () => {
  assert.deepEqual([...ai.ALLOWED_KEYS], ['firstName', 'middleName', 'lastName', 'fullName', 'suffix', 'birthDate', 'ssn', 'email', 'phone',
    'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county', 'ageRange', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors',
    'householdVeteran', 'householdDisability', 'totalMonthlyIncome', 'annualIncome', 'monthlyRent', 'monthlyUtilities', 'assetsOnHand',
    'monthlyMedicalExpenses', 'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare', 'anyoneSenior', 'iowaResident',
    'wantsHealthCoverage']);
  assert.ok(Object.isFrozen(ai.ALLOWED_KEYS));
});

test('the prompt describes labels, types, options, and allowed keys but never any value', () => {
  const { system, user } = ai.buildPrompt(fields(), ai.ALLOWED_KEYS);
  const text = `${system}\n${user}`;
  for (const item of fields()) {
    assert.ok(text.includes(item.id), item.id);
    assert.ok(text.includes(item.label), item.label);
  }
  for (const option of ['Yes', 'No', 'Iowa', 'Minnesota']) assert.ok(user.includes(option), option);
  for (const type of ['email', 'number', 'radio']) assert.ok(user.includes(type), type);
  for (const key of ai.ALLOWED_KEYS) assert.ok(system.includes(key), key);
  for (const secret of [...SECRET_VALUES, 'you@example.test', 'applicant_full']) assert.ok(!text.includes(secret), secret);
  assert.match(system, /JSON/);
  assert.match(system, /null/);
});

test('the prompt lists only the allowed keys it is given', () => {
  const { system } = ai.buildPrompt(fields(), ['email', 'state']);
  assert.ok(system.includes('email') && system.includes('state'));
  assert.ok(!system.includes('householdChildren'));
  assert.ok(!system.includes('ssn'));
});

test('the response schema has exactly the field ids, each limited to the allowed keys or null', () => {
  const { schema } = ai.buildPrompt(fields(), ['email', 'state']);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), ['sh-1', 'sh-2', 'sh-3', 'sh-4', 'sh-5', 'sh-6']);
  assert.deepEqual(schema.required, ['sh-1', 'sh-2', 'sh-3', 'sh-4', 'sh-5', 'sh-6']);
  for (const property of Object.values(schema.properties)) assert.deepEqual(property, { enum: ['email', 'state', null] });
  assert.ok(!JSON.stringify(schema).includes(SECRET_VALUES[0]));
});

test('malformed inputs fail loudly instead of producing a prompt', () => {
  assert.throws(() => ai.buildPrompt('not fields', ai.ALLOWED_KEYS), TypeError);
  assert.throws(() => ai.buildPrompt([{ id: '', label: 'Name', type: 'text' }], ai.ALLOWED_KEYS), TypeError);
  assert.throws(() => ai.buildPrompt([{ id: 'a', label: 7, type: 'text' }], ai.ALLOWED_KEYS), TypeError);
  assert.throws(() => ai.buildPrompt([{ id: 'a', label: 'Name', type: '' }], ai.ALLOWED_KEYS), TypeError);
  assert.throws(() => ai.buildPrompt([{ id: 'a', label: 'Name', type: 'radio', options: 'Yes' }], ai.ALLOWED_KEYS), TypeError);
  assert.throws(() => ai.buildPrompt([{ id: 'a', label: 'A', type: 'text' }, { id: 'a', label: 'B', type: 'text' }], ai.ALLOWED_KEYS), /Duplicate field id/);
  assert.throws(() => ai.buildPrompt(fields(), ['email', 'password']), /Unknown profile key: password/);
  assert.throws(() => ai.buildPrompt(fields(), []), TypeError);
  assert.throws(() => ai.buildPrompt(fields(), ['email', 'email']), TypeError);
});

test('a valid answer becomes a field-to-key mapping', () => {
  assert.deepEqual(ai.parseMapping(happyAnswer, fields(), ai.ALLOWED_KEYS), {
    mapping: { 'sh-1': 'fullName', 'sh-2': 'email', 'sh-3': 'householdChildren', 'sh-4': 'householdVeteran', 'sh-5': 'state' },
    rejected: []
  });
});

test('unknown field ids are dropped and null answers are left unmapped', () => {
  const result = ai.parseMapping(JSON.stringify({ 'sh-99': 'email', 'sh-1': 'fullName', 'sh-2': null }), fields(), ai.ALLOWED_KEYS);
  assert.deepEqual(result, { mapping: { 'sh-1': 'fullName' }, rejected: [] });
});

test('keys outside the allowlist are rejected', () => {
  const answer = JSON.stringify({ 'sh-1': 'password', 'sh-2': 'email', 'sh-5': 42 });
  assert.deepEqual(ai.parseMapping(answer, fields(), ai.ALLOWED_KEYS), { mapping: { 'sh-2': 'email' }, rejected: ['sh-1', 'sh-5'] });
  const narrowed = ai.parseMapping(JSON.stringify({ 'sh-1': 'fullName', 'sh-2': 'email' }), fields(), ['email']);
  assert.deepEqual(narrowed, { mapping: { 'sh-2': 'email' }, rejected: ['sh-1'] });
});

test('a key suggested for two fields keeps only the first field in page order', () => {
  const answer = JSON.stringify({ 'sh-2': 'email', 'sh-1': 'email' });
  assert.deepEqual(ai.parseMapping(answer, fields(), ai.ALLOWED_KEYS), { mapping: { 'sh-1': 'email' }, rejected: ['sh-2'] });
});

test('a rejected mismatch does not block a later field from using the key', () => {
  const answer = JSON.stringify({ 'sh-3': 'email', 'sh-2': 'email' });
  assert.deepEqual(ai.parseMapping(answer, fields(), ai.ALLOWED_KEYS), { mapping: { 'sh-2': 'email' }, rejected: ['sh-3'] });
});

test('count keys only land on number fields or numeric choices', () => {
  assert.equal(accepts('householdChildren', 'number'), true);
  assert.equal(accepts('householdSize', 'select-one', ['Choose one', '1', '2', '3', '4 or more']), true);
  assert.equal(accepts('householdAdults', 'radio', ['1', '2', '3+']), true);
  assert.equal(accepts('householdChildren', 'text'), false);
  assert.equal(accepts('householdSeniors', 'textarea'), false);
  assert.equal(accepts('householdSize', 'checkbox', ['1', '2']), false);
  assert.equal(accepts('householdChildren', 'radio', ['Yes', 'No']), false);
  assert.equal(accepts('householdSize', 'select-one', []), false);
});

test('yes/no keys only land on choices that offer yes and no', () => {
  assert.equal(accepts('householdVeteran', 'radio', ['Yes', 'No']), true);
  assert.equal(accepts('householdDisability', 'select-one', ['Choose one', 'Yes, someone does', 'No', 'Prefer not to say']), true);
  assert.equal(accepts('householdVeteran', 'checkbox', ['Yes']), true);
  assert.equal(accepts('householdVeteran', 'text'), false);
  assert.equal(accepts('householdVeteran', 'radio', ['Army', 'Navy', 'Air Force']), false);
  assert.equal(accepts('householdVeteran', 'radio', ['Yes', 'Not sure']), false);
  assert.equal(accepts('householdDisability', 'select-one', ['None', 'N/A']), false);
  assert.equal(accepts('householdDisability', 'checkbox', ['I agree']), false);
});

test('text keys only land on matching input types', () => {
  assert.equal(accepts('email', 'email'), true);
  assert.equal(accepts('email', 'text'), true);
  assert.equal(accepts('email', 'number'), false);
  assert.equal(accepts('email', 'tel'), false);
  assert.equal(accepts('email', 'radio', ['Yes', 'No']), false);
  assert.equal(accepts('phone', 'tel'), true);
  assert.equal(accepts('phone', 'email'), false);
  assert.equal(accepts('fullName', 'text'), true);
  assert.equal(accepts('fullName', 'textarea'), false);
  assert.equal(accepts('state', 'select-one', ['Iowa', 'Minnesota']), true);
  assert.equal(accepts('birthDate', 'date'), true);
  assert.equal(accepts('birthDate', 'number'), false);
  assert.equal(accepts('monthlyRent', 'number'), true);
  assert.equal(accepts('totalMonthlyIncome', 'text'), true);
  assert.equal(accepts('annualIncome', 'checkbox', ['Yes']), false);
  assert.equal(accepts('zip', 'text'), true);
  assert.equal(accepts('ssn', 'text'), true);
  assert.equal(accepts('ssn', 'email'), false);
  assert.equal(accepts('firstName', 'unknown-widget'), false);
});

test('an unreadable answer throws instead of mapping anything', () => {
  for (const text of ['not json', '{"sh-1": "fullName"', '', '[]', 'null', '"fullName"', '42']) {
    assert.throws(() => ai.parseMapping(text, fields(), ai.ALLOWED_KEYS), { message: UNREADABLE }, JSON.stringify(text));
  }
  assert.throws(() => ai.parseMapping(undefined, fields(), ai.ALLOWED_KEYS), { message: UNREADABLE });
});

test('an available model gets one prompt with the schema and the session is destroyed', async () => {
  const { LanguageModel, calls } = model();
  const result = await ai.mapWithChromeAI(fields(), { allowedKeys: ai.ALLOWED_KEYS, LanguageModel });
  assert.deepEqual(result, {
    status: 'mapped',
    mapping: { 'sh-1': 'fullName', 'sh-2': 'email', 'sh-3': 'householdChildren', 'sh-4': 'householdVeteran', 'sh-5': 'state' },
    rejected: []
  });
  const expected = ai.buildPrompt(fields(), ai.ALLOWED_KEYS);
  assert.deepEqual(calls.availability, [MODEL_OPTIONS]);
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0].expectedInputs, MODEL_OPTIONS.expectedInputs);
  assert.deepEqual(calls.create[0].expectedOutputs, MODEL_OPTIONS.expectedOutputs);
  assert.deepEqual(calls.create[0].initialPrompts, [{ role: 'system', content: expected.system }]);
  assert.ok(calls.create[0].signal instanceof AbortSignal);
  assert.equal(calls.prompt.length, 1);
  assert.equal(calls.prompt[0].text, expected.user);
  assert.deepEqual(calls.prompt[0].options.responseConstraint, expected.schema);
  assert.ok(calls.prompt[0].options.signal instanceof AbortSignal);
  assert.equal(calls.sessions[0].destroyed, 1);
  const sent = JSON.stringify([calls.create, calls.prompt]);
  for (const secret of SECRET_VALUES) assert.ok(!sent.includes(secret), secret);
});

test('rejected suggestions are reported alongside the mapping', async () => {
  const { LanguageModel } = model({ answer: JSON.stringify({ 'sh-1': 'householdChildren', 'sh-2': 'email' }) });
  assert.deepEqual(await ai.mapWithChromeAI(fields(), { LanguageModel }), { status: 'mapped', mapping: { 'sh-2': 'email' }, rejected: ['sh-1'] });
});

test('an unavailable model is reported and never prompted', async () => {
  const { LanguageModel, calls } = model({ availability: 'unavailable' });
  const result = await ai.mapWithChromeAI(fields(), { LanguageModel });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /isn’t available on this device/);
  assert.equal(calls.create.length, 0);
});

test('a model that is not downloaded is reported as unavailable without starting a download', async () => {
  const { LanguageModel, calls } = model({ availability: 'downloadable' });
  assert.deepEqual(await ai.mapWithChromeAI(fields(), { LanguageModel }), { status: 'unavailable', reason: 'Chrome’s on-device AI isn’t downloaded yet.' });
  assert.equal(calls.create.length, 0);
});

test('a model that is still downloading is reported and never prompted', async () => {
  const { LanguageModel, calls } = model({ availability: 'downloading' });
  const result = await ai.mapWithChromeAI(fields(), { LanguageModel });
  assert.equal(result.status, 'downloading');
  assert.match(result.reason, /downloading/);
  assert.equal(calls.create.length, 0);
});

test('a Chrome without the Prompt API is reported as unavailable', async () => {
  assert.equal(globalThis.LanguageModel, undefined);
  const result = await ai.mapWithChromeAI(fields());
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /Chrome/);
});

test('an unknown availability state or a failed check is an error, not a silent skip', async () => {
  const unknown = model({ availability: 'maybe-later' });
  const result = await ai.mapWithChromeAI(fields(), { LanguageModel: unknown.LanguageModel });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /maybe-later/);
  assert.equal(unknown.calls.create.length, 0);
  const broken = model({ availabilityError: new Error('Model service crashed') });
  const failed = await ai.mapWithChromeAI(fields(), { LanguageModel: broken.LanguageModel });
  assert.equal(failed.status, 'error');
  assert.match(failed.reason, /Model service crashed/);
});

test('a slow prompt times out, is aborted, and its session is destroyed', async () => {
  const { LanguageModel, calls } = model({ prompt: never });
  const result = await ai.mapWithChromeAI(fields(), { LanguageModel, timeoutMs: 20 });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /took too long/);
  assert.equal(calls.prompt[0].options.signal.aborted, true);
  assert.equal(calls.sessions[0].destroyed, 1);
});

test('a session that arrives after the timeout is destroyed when it arrives', async () => {
  let release;
  const { LanguageModel, calls } = model({ create: session => new Promise(resolve => { release = () => resolve(session); }) });
  const result = await ai.mapWithChromeAI(fields(), { LanguageModel, timeoutMs: 20 });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /took too long/);
  assert.equal(calls.create[0].signal.aborted, true);
  assert.equal(calls.prompt.length, 0);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.sessions[0].destroyed, 1);
});

test('a failed prompt is reported as an error and the session is destroyed', async () => {
  const { LanguageModel, calls } = model({ prompt: () => Promise.reject(new Error('The model could not follow the schema.')) });
  const result = await ai.mapWithChromeAI(fields(), { LanguageModel });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /could not follow the schema/);
  assert.equal(calls.sessions[0].destroyed, 1);
});

test('a failed session start is reported as an error', async () => {
  const { LanguageModel } = model({ create: () => Promise.reject(new Error('Not enough memory.')) });
  const result = await ai.mapWithChromeAI(fields(), { LanguageModel });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /Not enough memory/);
});

test('an unreadable model answer is an error and the session is destroyed', async () => {
  const { LanguageModel, calls } = model({ answer: 'Sure! Here is the mapping: sh-1 is fullName' });
  assert.deepEqual(await ai.mapWithChromeAI(fields(), { LanguageModel }), { status: 'error', reason: UNREADABLE });
  assert.equal(calls.sessions[0].destroyed, 1);
});

test('a caller abort cancels the prompt and destroys the session', async () => {
  const controller = new AbortController();
  const { LanguageModel, calls } = model({ prompt: () => { setImmediate(() => controller.abort()); return never(); } });
  const result = await ai.mapWithChromeAI(fields(), { LanguageModel, signal: controller.signal });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /cancelled/);
  assert.equal(calls.prompt[0].options.signal.aborted, true);
  assert.equal(calls.sessions[0].destroyed, 1);
});

test('no fields means no model call', async () => {
  const { LanguageModel, calls } = model();
  assert.deepEqual(await ai.mapWithChromeAI([], { LanguageModel }), { status: 'mapped', mapping: {}, rejected: [] });
  assert.equal(calls.availability.length, 0);
});

test('invalid options fail loudly', async () => {
  const { LanguageModel } = model();
  await assert.rejects(ai.mapWithChromeAI(fields(), { LanguageModel, timeoutMs: 0 }), TypeError);
  await assert.rejects(ai.mapWithChromeAI(fields(), { LanguageModel, allowedKeys: ['password'] }), /Unknown profile key/);
});

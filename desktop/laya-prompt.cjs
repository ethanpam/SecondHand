'use strict';

// How Laya turns a state and a typed question into model inputs, and logits into calibrated
// answers. A port of laya_mlx (common.py and Agent.system_one): the model was trained on
// exactly these prompts, so every detail, down to Python's JSON spacing, is kept.
const QTYPES = Object.freeze({ choice: 0, score: 1, noul: 2 });
const QTYPE_NAMES = Object.freeze(['choice', 'score', 'noul']);
const MAX_OPTION_TOKENS = 48;
const TEMPERATURE_RANGE = [0.5, 5];
const INDEX_KEY = /^(0|[1-9]\d*)$/;

const isPlainObject = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

function pythonString(text, asciiOnly) {
  if (!text.isWellFormed()) throw new TypeError('Laya text must be well-formed Unicode.');
  const quoted = JSON.stringify(text);
  return asciiOnly ? quoted.replace(/[^\x00-\x7f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) : quoted;
}

// Python's json.dumps with its default ", " and ": " separators. Floats are refused because
// Python and JavaScript print some of them differently.
function pythonJson(value, asciiOnly = false) {
  if (typeof value === 'string') return pythonString(value, asciiOnly);
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Laya state numbers must be whole numbers.');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => pythonJson(item, asciiOnly)).join(', ')}]`;
  if (isPlainObject(value)) {
    return `{${Object.entries(value).map(([key, item]) => `${pythonString(key, asciiOnly)}: ${pythonJson(item, asciiOnly)}`).join(', ')}}`;
  }
  if (value === undefined) throw new TypeError('Laya state values cannot be undefined.');
  throw new TypeError('Laya state values must be text, whole numbers, booleans, null, arrays, or plain objects.');
}

function serializeState(state) {
  if (typeof state === 'string') {
    if (!state.isWellFormed()) throw new TypeError('Laya text must be well-formed Unicode.');
    return state;
  }
  if (!isPlainObject(state) && !Array.isArray(state)) throw new TypeError('A Laya state must be text or a plain object.');
  return pythonJson(state);
}

const renderCriterion = value => typeof value === 'string' ? value : pythonJson(value);
const described = value => value !== null && value !== undefined && value !== '';

// The checked, internal form of one question (laya_mlx Agent._to_internal plus render_options).
function toQuestion(definition) {
  if (!isPlainObject(definition)) throw new TypeError('Each Laya question must be an object.');
  const { type, instructions, criteria } = definition;
  if (type !== 'choice' && type !== 'noul') throw new TypeError('Laya questions must be choice or noul.');
  if (instructions === undefined) throw new TypeError('A Laya question is missing its instructions.');
  const text = typeof instructions === 'string' ? instructions : pythonJson(instructions, true);
  if (type === 'noul') {
    if (criteria !== undefined && criteria !== null && !isPlainObject(criteria)) throw new TypeError('Noul criteria must be an object with false/true descriptions.');
    const falseText = criteria && described(criteria.false) ? renderCriterion(criteria.false) : 'no, the statement does not hold';
    const trueText = criteria && described(criteria.true) ? renderCriterion(criteria.true) : 'yes, the statement holds';
    return { type, instructions: text, labels: ['false', 'true'], options: [`false: ${falseText}`, `true: ${trueText}`] };
  }
  let entries;
  if (Array.isArray(criteria)) {
    if (!criteria.every(label => typeof label === 'string')) throw new TypeError('Choice labels must be strings.');
    if (new Set(criteria).size !== criteria.length) throw new TypeError('Choice labels must be unique.');
    entries = criteria.map(label => [label, null]);
  } else if (isPlainObject(criteria)) {
    entries = Object.entries(criteria);
    // JavaScript moves number-like keys first, so their order would not be the caller's.
    if (entries.some(([label]) => INDEX_KEY.test(label))) throw new TypeError('Give choice options with number-like labels as an array to keep their order.');
  } else throw new TypeError('Choice criteria must be a nonempty array or object.');
  if (!entries.length) throw new TypeError('Choice criteria must be a nonempty array or object.');
  return { type, instructions: text, labels: entries.map(([label]) => label),
    options: entries.map(([label, value]) => described(value) ? `${label}: ${renderCriterion(value)}` : label) };
}

// [CLS] <type> question: instructions [SEP] [MASK] option … [SEP] state [SEP], cut to maxLen.
function encodeDecision(tokenizer, state, question, { maxLen, headMaxLen }) {
  const mask = tokenizer.maskToken;
  const head = tokenizer.encode(`${question.type} question: ${question.instructions.replaceAll(mask, ' ')}`);
  let options = question.options.map(option => [tokenizer.maskId, ...tokenizer.encode(` ${option.replaceAll(mask, ' ')}`).slice(0, MAX_OPTION_TOKENS)]);
  const used = () => options.reduce((sum, option) => sum + option.length, 0);
  let budget = headMaxLen - used();
  if (budget < 16) {
    const each = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, options.length)));
    options = options.map(option => option.slice(0, each));
    budget = headMaxLen - used();
  }
  const ids = [tokenizer.clsId, ...head.slice(0, Math.max(8, budget)), tokenizer.sepId];
  const markers = [];
  for (const option of options) { markers.push(ids.length); ids.push(...option); }
  ids.push(tokenizer.sepId);
  const room = Math.max(0, maxLen - ids.length - 1);
  const stateIds = tokenizer.encode(serializeState(state).replaceAll(mask, ' ')).slice(0, room);
  const all = [...ids, ...stateIds, tokenizer.sepId].slice(0, maxLen);
  const kept = markers.filter(marker => marker < maxLen);
  if (kept.length !== question.options.length) throw new RangeError('A Laya question has too many options for the token budget.');
  return { ids: all, markers: kept, qtype: QTYPES[question.type] };
}

// The five inputs of the exported graph, padded to the longest row (laya_mlx collate_items).
function collate(items, padId) {
  const rows = items.length;
  const length = Math.max(...items.map(item => item.ids.length));
  const count = Math.max(2, ...items.map(item => item.markers.length));
  const inputIds = new BigInt64Array(rows * length).fill(BigInt(padId));
  const attentionMask = new BigInt64Array(rows * length);
  const markerPos = new BigInt64Array(rows * count);
  const markerMask = new Uint8Array(rows * count);
  const qtype = new BigInt64Array(rows);
  items.forEach((item, row) => {
    item.ids.forEach((id, index) => { inputIds[row * length + index] = BigInt(id); attentionMask[row * length + index] = 1n; });
    item.markers.forEach((marker, index) => { markerPos[row * count + index] = BigInt(marker); markerMask[row * count + index] = 1; });
    qtype[row] = BigInt(item.qtype);
  });
  return { rows, length, count, inputIds, attentionMask, markerPos, markerMask, qtype };
}

const clampTemperature = value => Math.min(TEMPERATURE_RANGE[1], Math.max(TEMPERATURE_RANGE[0], value));
const validTemperature = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

// A checkpoint's calibration temperatures. Values outside [0.5, 5] are clamped as laya_mlx does:
// some buckets were fitted to sharpen rather than soften, which would overstate confidence.
function readCalibration(config) {
  const temperature = config.temperature ?? [1, 1, 1];
  const byOptions = config.temperature_by_options ?? {};
  if (!Array.isArray(temperature) || temperature.length !== 3) throw new TypeError('Laya needs three calibration temperatures.');
  if (!isPlainObject(byOptions) || ![...temperature, ...Object.values(byOptions)].every(validTemperature)) {
    throw new TypeError('Laya calibration temperatures must be finite and positive.');
  }
  return { temperature: temperature.map(clampTemperature),
    byOptions: Object.fromEntries(Object.entries(byOptions).map(([bucket, value]) => [bucket, clampTemperature(value)])) };
}

function temperatureBucket(qtype, count) {
  const size = count <= 2 ? '2' : count <= 5 ? '3-5' : count <= 10 ? '6-10' : '11+';
  return `${QTYPE_NAMES[qtype]}:${size}`;
}

// Softmax over the first `count` logits after dividing by the bucket's temperature.
function probabilities(logits, count, qtype, calibration) {
  const values = Array.from(logits).slice(0, count);
  if (values.length !== count || !values.every(Number.isFinite)) throw new RangeError('Laya returned non-finite or missing scores.');
  const scale = calibration.byOptions[temperatureBucket(qtype, count)] ?? calibration.temperature[qtype];
  const scaled = values.map(value => value / scale);
  const top = Math.max(...scaled);
  const exps = scaled.map(value => Math.exp(value - top));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map(value => value / sum);
}

// 1 - H(p) / log(k): normalized-entropy confidence, as laya_mlx reports for choice questions.
function entropyConfidence(values) {
  if (values.length < 2) return 1;
  const entropy = -values.reduce((sum, value) => sum + value * Math.log(Math.min(1, Math.max(1e-12, value))), 0);
  return Math.min(1, Math.max(0, 1 - entropy / Math.log(values.length)));
}

function answerFor(question, values) {
  if (question.type === 'noul') return { type: 'noul', noul: values[1], confidence: Math.max(values[1], 1 - values[1]) };
  let best = 0;
  values.forEach((value, index) => { if (value > values[best]) best = index; });
  return { type: 'choice', choice: question.labels[best],
    probabilities: Object.fromEntries(question.labels.map((label, index) => [label, values[index]])), confidence: entropyConfidence(values) };
}

module.exports = { serializeState, toQuestion, encodeDecision, collate, readCalibration, probabilities, answerFor };

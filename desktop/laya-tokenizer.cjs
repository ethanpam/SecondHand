'use strict';

// Laya's tokenizer (ModernBERT's byte-level BPE, from a Hugging Face tokenizer.json) in plain
// JavaScript. It reproduces the Python `tokenizers` ids exactly for this layout; any other
// layout is refused when the file is loaded rather than tokenized differently.
const fs = require('node:fs/promises');
const path = require('node:path');

// Oniguruma's \s (Unicode White_Space), which Hugging Face's regex uses. JavaScript's \s adds
// U+FEFF and leaves out U+0085, so the class is spelled out.
const SPACE = '\\t\\n\\v\\f\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const IS_SPACE = new RegExp(`^[${SPACE}]$`, 'u');
// GPT-2's pre-tokenizer pattern, as ByteLevel(use_regex=True) applies it.
const PIECES = new RegExp(`'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^${SPACE}\\p{L}\\p{N}]+|[${SPACE}]+(?![^${SPACE}])|[${SPACE}]+`, 'gu');
const CACHE_LIMIT = 10000;

// GPT-2's reversible map from each byte to a printable character.
const BYTE_CHARS = (() => {
  const printable = [];
  for (let byte = 33; byte <= 126; byte++) printable.push(byte);
  for (let byte = 161; byte <= 172; byte++) printable.push(byte);
  for (let byte = 174; byte <= 255; byte++) printable.push(byte);
  const chars = new Array(256);
  let extra = 0;
  for (let byte = 0; byte < 256; byte++) chars[byte] = String.fromCodePoint(printable.includes(byte) ? byte : 256 + extra++);
  return chars;
})();

function refuse(detail) {
  throw new Error(`This Laya tokenizer isn't supported: ${detail}.`);
}

function checkLayout(json) {
  const model = json.model || {};
  if (model.type !== 'BPE') refuse('the model must be BPE');
  if (model.byte_fallback) refuse('byte fallback is not implemented');
  if (model.dropout !== null && model.dropout !== undefined) refuse('BPE dropout is not implemented');
  if (model.continuing_subword_prefix || model.end_of_word_suffix) refuse('subword prefixes and suffixes are not implemented');
  if (model.ignore_merges) refuse('ignore_merges is not implemented');
  const pre = json.pre_tokenizer || {};
  if (pre.type !== 'ByteLevel' || pre.use_regex === false) refuse('the pre-tokenizer must be ByteLevel with its regex');
  if (pre.add_prefix_space) refuse('a prefix space is not implemented');
  if (json.normalizer && json.normalizer.type !== 'NFC') refuse('only the NFC normalizer is implemented');
  for (const token of json.added_tokens || []) if (token.single_word) refuse('single-word added tokens are not implemented');
}

// A pattern that finds added tokens leftmost-longest, as Hugging Face's Aho-Corasick does:
// literal alternatives sorted longest first make the first alternative that matches the longest.
function addedPattern(contents) {
  if (!contents.length) return null;
  const escaped = [...contents].sort((a, b) => b.length - a.length).map(content => content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'gu');
}

class Tokenizer {
  constructor(json, config) {
    checkLayout(json);
    this.vocab = new Map(Object.entries(json.model.vocab));
    // Every byte UTF-8 text can contain needs a symbol (0xC0, 0xC1 and 0xF5-0xFF never occur).
    BYTE_CHARS.forEach((char, byte) => {
      if ((byte < 0xc0 || (byte >= 0xc2 && byte <= 0xf4)) && !this.vocab.has(char)) refuse(`the vocabulary has no entry for byte 0x${byte.toString(16)}`);
    });
    this.ranks = new Map();
    json.model.merges.forEach((merge, rank) => {
      const [left, right] = Array.isArray(merge) ? merge : merge.split(' ');
      this.ranks.set(`${left} ${right}`, rank);
    });
    this.normalize = json.normalizer ? text => text.normalize('NFC') : text => text;
    this.added = new Map(json.added_tokens.map(token => [token.content, token]));
    // Tokens marked normalized are looked for in normalized text, so their content is normalized too.
    const raw = json.added_tokens.filter(token => !token.normalized);
    const normalized = json.added_tokens.filter(token => token.normalized);
    this.rawTokens = new Map(raw.map(token => [token.content, token]));
    this.normalizedTokens = new Map(normalized.map(token => [this.normalize(token.content), token]));
    this.rawPattern = addedPattern([...this.rawTokens.keys()]);
    this.normalizedPattern = addedPattern([...this.normalizedTokens.keys()]);
    this.cache = new Map();
    for (const name of ['cls', 'sep', 'pad', 'mask']) {
      const value = config[`${name}_token`];
      const content = typeof value === 'object' && value ? value.content : value;
      const token = typeof content === 'string' ? this.added.get(content) : undefined;
      if (!token && !this.vocab.has(content)) refuse(`it is missing a valid ${name}_token`);
      this[`${name}Token`] = content;
      this[`${name}Id`] = token ? token.id : this.vocab.get(content);
    }
  }

  // Splits text around added tokens, honoring lstrip/rstrip like Hugging Face's find_matches.
  splitAdded(text, pattern, tokens) {
    if (!pattern) return [{ text }];
    const parts = [];
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      const token = tokens.get(match[0]);
      let start = match.index;
      let stop = start + match[0].length;
      if (token.lstrip) {
        while (start > offset && IS_SPACE.test(text[start - 1])) start--;
      }
      if (token.rstrip) {
        while (stop < text.length && IS_SPACE.test(text[stop])) stop++;
      }
      if (offset < start) parts.push({ text: text.slice(offset, start) });
      parts.push({ id: token.id });
      offset = stop;
    }
    if (offset < text.length) parts.push({ text: text.slice(offset) });
    return parts;
  }

  bpe(word) {
    const cached = this.cache.get(word);
    if (cached) return cached;
    const symbols = Array.from(word, char => ({ text: char, prev: -1, next: -1, gone: false }));
    symbols.forEach((symbol, index) => { symbol.prev = index - 1; symbol.next = index + 1 < symbols.length ? index + 1 : -1; });
    // Hugging Face's merge loop: lowest rank first, then leftmost, skipping expired entries.
    const queue = new MergeQueue();
    const push = (position, left, right) => {
      const rank = this.ranks.get(`${left} ${right}`);
      if (rank !== undefined) queue.push({ rank, position, result: left + right });
    };
    for (let index = 0; index + 1 < symbols.length; index++) push(index, symbols[index].text, symbols[index + 1].text);
    while (queue.size) {
      const top = queue.pop();
      const current = symbols[top.position];
      if (current.gone || current.next < 0) continue;
      const right = symbols[current.next];
      if (current.text + right.text !== top.result || this.ranks.get(`${current.text} ${right.text}`) === undefined) continue;
      current.text = top.result;
      right.gone = true;
      current.next = right.next;
      if (right.next >= 0) symbols[right.next].prev = top.position;
      if (current.prev >= 0) push(current.prev, symbols[current.prev].text, current.text);
      if (current.next >= 0) push(top.position, current.text, symbols[current.next].text);
    }
    const ids = symbols.filter(symbol => !symbol.gone).map(symbol => {
      const id = this.vocab.get(symbol.text);
      if (id === undefined) throw new Error(`The Laya tokenizer has no id for ${JSON.stringify(symbol.text)}.`);
      return id;
    });
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(word, ids);
    return ids;
  }

  encode(text) {
    if (typeof text !== 'string' || !text.isWellFormed()) throw new TypeError('Laya can only tokenize well-formed text.');
    const ids = [];
    const encoder = new TextEncoder();
    for (const raw of this.splitAdded(text, this.rawPattern, this.rawTokens)) {
      if (raw.id !== undefined) { ids.push(raw.id); continue; }
      for (const part of this.splitAdded(this.normalize(raw.text), this.normalizedPattern, this.normalizedTokens)) {
        if (part.id !== undefined) { ids.push(part.id); continue; }
        let offset = 0;
        const pieces = [];
        for (const match of part.text.matchAll(PIECES)) {
          if (match.index > offset) pieces.push(part.text.slice(offset, match.index));
          pieces.push(match[0]);
          offset = match.index + match[0].length;
        }
        if (offset < part.text.length) pieces.push(part.text.slice(offset));
        for (const piece of pieces) {
          let word = '';
          for (const byte of encoder.encode(piece)) word += BYTE_CHARS[byte];
          ids.push(...this.bpe(word));
        }
      }
    }
    return ids;
  }
}

// A binary heap ordered like Hugging Face's Merge: lowest rank, then lowest position.
class MergeQueue {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  before(a, b) { return a.rank < b.rank || (a.rank === b.rank && a.position < b.position); }
  push(item) {
    const items = this.items;
    items.push(item);
    for (let index = items.length - 1; index > 0;) {
      const parent = (index - 1) >> 1;
      if (!this.before(items[index], items[parent])) break;
      [items[index], items[parent]] = [items[parent], items[index]];
      index = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      for (let index = 0; ;) {
        const left = 2 * index + 1;
        const right = left + 1;
        let best = index;
        if (left < items.length && this.before(items[left], items[best])) best = left;
        if (right < items.length && this.before(items[right], items[best])) best = right;
        if (best === index) break;
        [items[index], items[best]] = [items[best], items[index]];
        index = best;
      }
    }
    return top;
  }
}

async function loadTokenizer(directory) {
  const [json, config] = await Promise.all(['tokenizer.json', 'tokenizer_config.json']
    .map(async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))));
  return new Tokenizer(json, config);
}

module.exports = { loadTokenizer };

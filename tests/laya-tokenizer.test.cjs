'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTokenizer } = require('../desktop/laya-tokenizer.cjs');

// Made by ML_model/eval/runtime_fixtures.py with Hugging Face `tokenizers` (ModernBERT's layout).
const small = path.join(__dirname, 'fixtures/laya/small-tokenizer');
const cases = require('./fixtures/laya/small-tokenizer-cases.json');

function withTokenizerJson(t, change) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-tokenizer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const json = JSON.parse(fs.readFileSync(path.join(small, 'tokenizer.json'), 'utf8'));
  change(json);
  fs.writeFileSync(path.join(directory, 'tokenizer.json'), JSON.stringify(json));
  fs.copyFileSync(path.join(small, 'tokenizer_config.json'), path.join(directory, 'tokenizer_config.json'));
  return directory;
}

test('token ids match Python tokenizers exactly, including added tokens, space runs, and Unicode edge cases', async () => {
  const tokenizer = await loadTokenizer(small);
  assert.ok(cases.encode.length >= 20);
  for (const { text, ids } of cases.encode) assert.deepEqual(tokenizer.encode(text), ids, JSON.stringify(text));
});

test('the special token ids come from tokenizer_config.json', async () => {
  const tokenizer = await loadTokenizer(small);
  const json = JSON.parse(fs.readFileSync(path.join(small, 'tokenizer.json'), 'utf8'));
  const id = content => json.added_tokens.find(token => token.content === content).id;
  assert.deepEqual([tokenizer.clsId, tokenizer.sepId, tokenizer.padId, tokenizer.maskId], [id('[CLS]'), id('[SEP]'), id('[PAD]'), id('[MASK]')]);
  assert.equal(tokenizer.maskToken, '[MASK]');
});

test('words seen before (served from the word cache) still give the Python ids', async () => {
  const tokenizer = await loadTokenizer(small);
  for (let round = 0; round < 3; round++) {
    for (const { text, ids } of cases.encode) assert.deepEqual(tokenizer.encode(text), ids, JSON.stringify(text));
  }
});

test('tokenizer files this port does not implement are refused when loaded', async t => {
  const refused = [
    ['a WordPiece model', json => { json.model.type = 'WordPiece'; }, /BPE/],
    ['byte fallback', json => { json.model.byte_fallback = true; }, /byte fallback/],
    ['BPE dropout', json => { json.model.dropout = 0.1; }, /dropout/],
    ['a subword prefix', json => { json.model.continuing_subword_prefix = '##'; }, /prefix/],
    ['a Metaspace pre-tokenizer', json => { json.pre_tokenizer = { type: 'Metaspace' }; }, /ByteLevel/],
    ['a prefix space', json => { json.pre_tokenizer.add_prefix_space = true; }, /prefix space/],
    ['a lowercase normalizer', json => { json.normalizer = { type: 'Lowercase' }; }, /normalizer/],
    ['a single-word added token', json => { json.added_tokens[0].single_word = true; }, /single-word/],
    ['a vocabulary missing a byte', json => { delete json.model.vocab['Ġ']; }, /byte/]
  ];
  for (const [name, change, message] of refused) {
    await assert.rejects(loadTokenizer(withTokenizerJson(t, change)), message, name);
  }
  await assert.rejects(loadTokenizer(path.join(os.tmpdir(), 'secondhand-missing-tokenizer')), /ENOENT/);
});

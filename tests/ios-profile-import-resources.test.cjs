'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('iOS document import bundles and loads the schema dependencies without Node or model access', () => {
  const root = path.join(__dirname, '..');
  const swift = fs.readFileSync(path.join(root, 'ios/SecondHand/Core/ProfileDocumentImport.swift'), 'utf8');
  const project = fs.readFileSync(path.join(root, 'ios/SecondHand.xcodeproj/project.pbxproj'), 'utf8');
  const loadOrder = [...swift.match(/for name in \[([^\]]+)\]/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.ok(loadOrder.indexOf('custom-fields') < loadOrder.indexOf('schema'));
  const context = vm.createContext({});
  vm.runInContext("var modules = {'node:crypto': {randomUUID: function() { throw new Error('Unavailable'); }}}; function require(name) { if (!(name in modules)) throw new Error('Unknown module: ' + name); return modules[name]; }", context);
  for (const name of loadOrder) {
    const file = `${name}.${name === 'snap-information' ? 'js' : 'cjs'}`;
    assert.ok(project.includes(`../shared/${file}`), `${file} must be packaged for the iOS loader`);
    const source = fs.readFileSync(path.join(root, 'shared', file), 'utf8');
    vm.runInContext(`modules[${JSON.stringify(`./${file}`)}] = (function() { var module = {exports:{}}; ${source}\n return module.exports; })();`, context, { filename: file });
  }
  const profile = vm.runInContext("JSON.stringify(modules['./schema.cjs'].validateProfile({firstName:'Fictional', customFields:[{id:'a0000000-0000-4000-8000-000000000001',label:'Recurring question',value:'User supplied answer',aliases:[]}]}))", context);
  assert.equal(JSON.parse(profile).customFields[0].value, 'User supplied answer');
  assert.equal(vm.runInContext("modules['./document-parser.cjs'].analyzeDocument({pages:[]}).type", context), 'unknown');
  assert.throws(() => vm.runInContext("modules['./schema.cjs'].validateProfile({customFields:[{id:'a0000000-0000-4000-8000-000000000001',label:'Question',value:'',aliases:[]}]})", context), /custom answer/i);
  assert.equal(vm.runInContext("'./laya-prompts.cjs' in modules", context), false);
});

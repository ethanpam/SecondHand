(function () {
  'use strict';
  const catalog = window.SecondHandSnapInformation;
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  function fieldControl(field, value, id) {
    const wrap = node('div', 'field');
    const label = node('label', '', field.label); label.htmlFor = id;
    const control = node(field.options ? 'select' : 'input');
    control.id = id;
    if (field.options) for (const [value, label] of field.options) {
      const option = node('option', '', label); option.value = value; control.append(option);
    }
    else {
      control.type = ['date', 'email', 'tel'].includes(field.type) ? field.type : 'text';
      control.maxLength = field.maxLength || 200;
      control.autocomplete = 'off';
      if (field.type === 'money') { control.inputMode = 'decimal'; control.pattern = '[0-9]{1,8}(\\.[0-9]{1,2})?'; }
      if (field.type === 'state') { control.maxLength = 2; control.placeholder = 'e.g. IA'; }
      if (field.type === 'zip') { control.maxLength = 10; control.inputMode = 'numeric'; }
      if (field.key === 'ssn') { control.maxLength = 11; control.inputMode = 'numeric'; }
    }
    control.value = typeof value === 'string' ? value : '';
    wrap.append(label, control);
    if (field.hint) {
      const hint = node('p', 'field-hint', field.hint); hint.id = `${id}-hint`;
      control.setAttribute('aria-describedby', hint.id); wrap.append(hint);
    }
    return { wrap, control };
  }
  function create(container, changed) {
    const lists = new Map();
    for (const section of catalog.sections) {
      const details = node('details', 'snap-section');
      details.append(node('summary', '', section.label));
      if (section.description) details.append(node('p', 'field-hint', section.description));
      const grid = node('div', 'field-grid');
      for (const field of section.fields) {
        const { wrap, control } = fieldControl(field, '', field.key);
        control.name = field.key; grid.append(wrap);
      }
      details.append(grid); container.append(details);
    }
    for (const record of catalog.records) {
      const details = node('details', 'snap-section'); details.dataset.recordSection = record.key;
      const summary = node('summary', '', record.label);
      const rows = node('div', 'snap-records'); rows.dataset.recordList = record.key;
      const add = node('button', 'button button-secondary', 'Add a record'); add.type = 'button'; add.dataset.addRecord = record.key;
      add.setAttribute('aria-label', `Add a record to ${record.label}`);
      const hint = node('p', 'field-hint', record.description || 'Add each person and amount separately. Leave unknown answers blank; enter 0 only when the amount is zero. These details help you prepare later pages that still need your review.');
      details.append(summary, hint, rows, add); container.append(details);
      const entry = { record, details, rows, add, summary };
      lists.set(record.key, entry);
      add.addEventListener('click', () => append(record.key, {}, true));
    }
    function refresh(entry) {
      entry.add.disabled = entry.rows.children.length >= catalog.maxRecords;
      entry.summary.textContent = entry.record.label + (entry.rows.children.length ? ` (${entry.rows.children.length})` : '');
      [...entry.rows.children].forEach((row, index) => {
        row.querySelector('legend').textContent = `Record ${index + 1}`;
        row.querySelector('button').setAttribute('aria-label', `Remove ${entry.record.label} record ${index + 1}`);
      });
    }
    function append(key, values, notify = false) {
      const entry = lists.get(key);
      if (!entry || entry.rows.children.length >= catalog.maxRecords) return false;
      const row = node('fieldset', 'snap-record'); row.dataset.recordId = values.id || window.crypto.randomUUID();
      const grid = node('div', 'field-grid');
      row.append(node('legend'), grid);
      for (const field of entry.record.fields) {
        const { wrap, control } = fieldControl(field, values[field.key], `record-${key}-${row.dataset.recordId}-${field.key}`);
        control.dataset.recordField = field.key; grid.append(wrap);
      }
      const remove = node('button', 'text-button danger', 'Remove this record'); remove.type = 'button';
      remove.addEventListener('click', () => { row.remove(); refresh(entry); changed(); });
      row.append(remove); entry.rows.append(row); refresh(entry);
      if (notify) { entry.details.open = true; changed(); grid.querySelector('input, select')?.focus(); }
      return true;
    }
    return {
      append,
      render(profile) {
        for (const [key, entry] of lists) {
          entry.rows.replaceChildren(); entry.details.open = false;
          for (const value of (Array.isArray(profile[key]) ? profile[key] : []).slice(0, catalog.maxRecords)) append(key, value);
          refresh(entry);
        }
      },
      read() {
        return Object.fromEntries([...lists].map(([key, entry]) => [key, [...entry.rows.children].map(row => ({
          id: row.dataset.recordId,
          ...Object.fromEntries([...row.querySelectorAll('[data-record-field]')].map(control => [control.dataset.recordField, control.value.trim()]))
        }))]));
      },
      reviewTarget(key) {
        const [list, index, field] = key.split('.'); const entry = lists.get(list);
        if (!entry) return null;
        const row = /^\d+$/.test(index || '') ? entry.rows.children[Number(index)] : null;
        const control = row && [...row.querySelectorAll('[data-record-field]')].find(item => item.dataset.recordField === field);
        return { container: control?.closest('.field') || row || entry.details, controls: control ? [control] : [] };
      }
    };
  }
  function memberDetails(row, member) {
    const original = new Set(['firstName', 'lastName', 'birthDate', 'relationship', 'student', 'grade']);
    const details = node('details', 'snap-member-details'); details.append(node('summary', '', 'More information about this person'));
    const grid = node('div', 'field-grid');
    for (const field of catalog.memberFields.filter(field => !original.has(field.key))) {
      const { wrap, control } = fieldControl(field, member[field.key], `member-${member.id}-${field.key}`);
      control.dataset.memberField = field.key; grid.append(wrap);
    }
    details.append(grid); row.append(details);
  }
  window.SecondHandSnapEditor = { create, memberDetails };
})();

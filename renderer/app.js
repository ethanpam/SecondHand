'use strict';

(() => {
  const api = window.secondHand;
  const $ = (id) => document.getElementById(id);
  const profileFields = ['firstName', 'middleName', 'lastName', 'suffix', 'maidenName', 'isApplicant',
    'birthDate', 'ssn', 'email', 'phone', 'homePhone', 'mobilePhone', 'bestContactTime',
    'hasHomeAddress', 'mailingSameAsHome', 'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county',
    'mailingAddressLine1', 'mailingAddressLine2', 'mailingCity', 'mailingState', 'mailingZip',
    'programSnap', 'programFip', 'programMedicaid', 'helpPayMedicalBills', 'householdSize',
    'householdAdults', 'householdChildren', 'householdSeniors', 'householdVeteran', 'householdDisability',
    'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare',
    'monthlyEarnedIncome', 'monthlyOtherIncome', 'monthlyRent', 'monthlyUtilities', 'assetsOnHand', 'monthlyMedicalExpenses',
    'sex', 'maritalStatus', 'hasSsnAnswer', 'ssnCardNameMatches', 'usCitizen', 'militaryOrVeteran', 'disabled', 'blind', 'healthLimitation', 'medicare'];
  const viewNames = { overview: 'Overview', profile: 'My information', documents: 'Documents', applications: 'Applications', extension: 'Chrome extension', privacy: 'Privacy & backups' };
  const statusNames = { draft: 'Draft', in_progress: 'In progress', submitted: 'Submitted', needs_action: 'Needs action', approved: 'Approved', denied: 'Denied' };
  let vaultStatus = { exists: false, unlocked: false, recoveryKey: false, deviceReset: false, deviceResetSupported: false, extensionId: '', bridgeRunning: false };
  let data = { profile: {}, applications: [] };
  let currentView = 'overview';
  let profileDirty = false;
  let profileRevision = 0;
  let applicationBusy = false;
  let applicationRefreshRevision = 0;
  let toastTimer;
  let vaultGeneration = 0;
  let handledLockRevision = -1;
  let documentRevision = 0;
  let documentRequestId = null;
  let documentBusy = false;
  let documentFields = [];
  let stopDocumentProgress = null;
  const documentProfileKeys = new Set(['firstName', 'middleName', 'lastName', 'ssn', 'addressLine1', 'addressLine2', 'city', 'state', 'zip']);
  let layaPoll;
  const LAYA_POLL_MS = 500;
  // The household list (#98): each person who lives with the applicant, the applicant's own row first.
  // The rows are part of the profile draft and are saved with the form.
  const RELATIONSHIPS = [['spouse-partner', 'Spouse or partner'], ['child', 'Child'], ['parent', 'Parent'], ['sibling', 'Brother or sister'],
    ['grandchild', 'Grandchild'], ['other-relative', 'Other relative'], ['other', 'Someone else']];
  const MAX_MEMBERS = 20;
  const COUNT_FIELDS = ['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'];
  // The manual counts while the list sets them, to show again if the list is removed.
  let manualCounts = null;
  // The guided first-run setup: six steps over the same My information form, each saved as the applicant moves on.
  const SETUP_STEPS = [
    { title: 'You', intro: 'Your name, date of birth, and how to reach you.' },
    { title: 'Your household', intro: 'Everyone who lives with you and shares food with you. SecondHand works out their ages from their birth dates.' },
    { title: 'Where you live', intro: 'Your home address and where you get mail.' },
    { title: 'Income and money on hand', intro: 'Monthly income, housing costs, money on hand, and medical costs. Leave blank anything you don’t know yet.' },
    { title: 'Programs', intro: 'The programs you want to ask Iowa for.' },
    { title: 'About you', intro: 'Iowa’s questions about you, so SecondHand can answer them on Iowa’s Tell Us More page.' }
  ];
  // How many steps the desktop says are done ({ step, steps }), or null when no setup is under way.
  let setupProgress = null;
  // The step on screen (0 to 5) while the guided setup is open, else null.
  let setupStep = null;
  // A new password offers the setup once its recovery key is saved.
  let offerSetup = false;

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  // Ring loader for buttons marked data-loader: a faint track plus an arc
  // that grows, shrinks, and turns. Styles live in styles.css (the CSP allows
  // no inline styles), and it is hidden from screen readers since the button
  // already reports aria-busy.
  function loader() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('loader');
    svg.setAttribute('viewBox', '0 0 40 40');
    svg.setAttribute('aria-hidden', 'true');
    for (const part of ['loader-track', 'loader-arc']) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.classList.add(part);
      for (const [name, value] of [['cx', '20'], ['cy', '20'], ['r', '17.5'], ['pathLength', '100']]) circle.setAttribute(name, value);
      svg.append(circle);
    }
    return svg;
  }

  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  function showError(id, error) {
    const target = $(id);
    target.textContent = error instanceof Error ? error.message : String(error || 'Something went wrong. Please try again.');
    target.hidden = false;
  }

  function clearError(id) {
    $(id).textContent = '';
    $(id).hidden = true;
  }

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; $('toast').textContent = ''; }, 6000);
  }

  async function pending(button, action) {
    if (button.disabled) return;
    const generation = vaultGeneration;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (button.hasAttribute('data-loader')) button.append(loader());
    try { return await action(); }
    finally {
      if (generation === vaultGeneration) {
        button.disabled = !api;
        button.removeAttribute('aria-busy');
        button.querySelector(':scope > .loader')?.remove();
      }
    }
  }

  function setApplicationBusy(value) {
    applicationBusy = value;
    $('application-form').querySelectorAll('input, select, textarea, button').forEach((control) => { control.disabled = value; });
    $('application-form').setAttribute('aria-busy', String(value));
  }

  function setProfileDirty(value) {
    profileDirty = value;
    // Shown only while there is something to save.
    $('profile-save-state').textContent = value ? 'Unsaved changes' : '';
    $('profile-save-state').hidden = !value;
    $('profile-nav-dot').hidden = !value;
  }

  function clearSensitiveUI() {
    vaultGeneration++;
    offerSetup = false;
    setupProgress = null;
    closeSetup();
    if ($('setup-dialog').open) $('setup-dialog').close();
    clearDocumentReview();
    document.querySelectorAll('button[aria-busy="true"]').forEach((button) => {
      button.disabled = !api;
      button.removeAttribute('aria-busy');
      button.querySelector(':scope > .loader')?.remove();
    });
    setApplicationBusy(false);
    data = { profile: {}, applications: [] };
    $('profile-form').reset();
    manualCounts = null;
    renderMembers([]);
    renderSetupResume();
    $('application-form').reset();
    $('application-id').value = '';
    $('auth-form').reset();
    $('reset-form').reset();
    if ($('recovery-dialog').open) $('recovery-dialog').close();
    clearRecoveryKey();
    closeTouchIdDialog();
    $('application-list').replaceChildren();
    $('overview-applications').replaceChildren();
        $('application-count').textContent = '0';
    if ($('application-dialog').open) $('application-dialog').close();
    clearTimeout(layaPoll);
    for (const id of ['auth-error', 'reset-error', 'profile-error', 'application-error', 'extension-error', 'extension-prepare-error', 'autofill-trust-error', 'laya-error', 'touch-id-error']) clearError(id);
    setProfileDirty(false);
    clearTimeout(toastTimer);
    $('toast').hidden = true;
    $('toast').textContent = '';
  }

  function showLocked(status = vaultStatus, { refresh = false } = {}) {
    const revision = Number.isSafeInteger(status.lockRevision) && status.lockRevision >= 0 ? status.lockRevision : null;
    // The status reply and event can arrive in either order. Clear once for
    // that transition; a later revision must still cancel pending auth/data.
    if (!refresh && revision !== null && revision <= handledLockRevision) return;
    if (revision !== null) handledLockRevision = Math.max(handledLockRevision, revision);
    clearSensitiveUI();
    vaultStatus = { ...status, unlocked: false };
    $('workspace').hidden = true;
    $('auth-view').hidden = false;
    const exists = Boolean(vaultStatus.exists);
    $('auth-title').textContent = exists ? 'Welcome back' : 'Create a password';
    $('auth-description').textContent = exists ? 'Enter your password to pick up where you left off. Your information is right here on this computer.' : 'Your password protects the information you save in SecondHand. It is encrypted and stays on this computer.';
    $('confirm-passphrase-field').hidden = exists;
    $('confirm-passphrase').required = !exists;
    $('passphrase').minLength = exists ? 1 : 12;
    $('passphrase').autocomplete = exists ? 'current-password' : 'new-password';
    $('passphrase-hint').textContent = exists ? 'Enter the password you created for SecondHand.' : 'Use at least 12 characters. A few words you can remember work well.';
    $('auth-submit').replaceChildren(document.createTextNode(exists ? 'Unlock ' : 'Create password '), icon(exists ? 'lock' : 'arrow'));
    $('recovery-note').textContent = exists ? 'Your password never leaves this computer.' : 'Keep your password somewhere safe. You’ll also get a recovery key in case you forget it.';
    $('forgot-password').hidden = !exists;
    $('device-reset-field').hidden = exists || !vaultStatus.deviceResetSupported;
    $('allow-device-reset').checked = true;
    setResetMode(false);
    renderTouchIdUnlock();
    if (api) $('passphrase').focus();
  }

  // The lock screen's Unlock with Touch ID, when it's ready, or a line saying why Touch ID was turned off.
  function renderTouchIdUnlock() {
    const locked = Boolean(vaultStatus.exists) && !vaultStatus.unlocked;
    $('touch-id-unlock').hidden = !(locked && vaultStatus.touchId === 'ready');
    const notice = locked && typeof vaultStatus.touchIdNotice === 'string' ? vaultStatus.touchIdNotice : '';
    $('touch-id-note').textContent = notice;
    $('touch-id-note').hidden = !notice;
  }

  // Touch ID's state can change while the lock screen shows (an auto-lock, a failed attempt).
  async function refreshTouchIdUnlock() {
    const generation = vaultGeneration;
    try {
      const status = await api.status();
      if (generation !== vaultGeneration || vaultStatus.unlocked || status.unlocked) return;
      vaultStatus = { ...vaultStatus, touchId: status.touchId, touchIdSupported: status.touchIdSupported, touchIdNotice: status.touchIdNotice };
      renderTouchIdUnlock();
    } catch (error) { if (generation === vaultGeneration) showError('auth-error', error); }
  }

  // Unlock with Touch ID in Privacy & backups: shown only on a Mac that can use it.
  function renderTouchId() {
    $('touch-id-setting').hidden = !vaultStatus.touchIdSupported;
    $('touch-id-toggle').checked = vaultStatus.touchId === 'ready';
  }

  function closeTouchIdDialog() {
    if ($('touch-id-dialog').open) $('touch-id-dialog').close();
    $('touch-id-form').reset();
    clearError('touch-id-error');
  }

  function resetWithDevice() {
    return Boolean(vaultStatus.deviceReset) && (!vaultStatus.recoveryKey || $('reset-method-device').checked);
  }

  function renderResetMethod() {
    const device = resetWithDevice();
    $('recovery-key-field').hidden = device;
    $('recovery-key-input').required = !device;
    $('auth-description').textContent = device ? 'Choose a new password. Your saved information stays as it is.' : 'Enter your recovery key and choose a new password. Your saved information stays as it is.';
  }

  function startOverConfirmed() {
    return $('start-over-confirm').value.trim().toLowerCase() === 'start over';
  }

  // For someone who has lost both their password and recovery key.
  function setStartOverMode(active) {
    $('start-over-form').reset();
    clearError('start-over-error');
    $('start-over-submit').disabled = true;
    $('start-over-form').hidden = !active;
    if (!active) return;
    $('reset-form').hidden = true;
    $('auth-title').textContent = 'Start over';
    $('auth-description').textContent = 'If you can’t reset your password, you can erase your saved information and create a new password.';
    $('start-over-confirm').focus();
  }

  function setResetMode(active) {
    const available = Boolean(vaultStatus.recoveryKey || vaultStatus.deviceReset);
    setStartOverMode(false);
    $('reset-form').reset();
    clearError('reset-error'); clearError('auth-error');
    $('auth-form').hidden = active;
    $('reset-form').hidden = !active;
    $('recovery-note').hidden = active;
    $('reset-fields').hidden = !available;
    $('reset-unavailable').hidden = available;
    $('reset-submit').hidden = !available;
    if (!active) return;
    $('auth-title').textContent = 'Reset your password';
    $('reset-method').hidden = !(vaultStatus.recoveryKey && vaultStatus.deviceReset);
    if (!available) { $('auth-description').textContent = 'Without your password or a recovery key, SecondHand can’t open your saved information.'; return; }
    renderResetMethod();
    (resetWithDevice() ? $('reset-password') : $('recovery-key-input')).focus();
  }

  function clearRecoveryKey() {
    $('recovery-key-value').textContent = '';
    $('recovery-feedback').textContent = '';
    $('recovery-saved').checked = false;
    $('recovery-done').disabled = true;
  }

  function showRecoveryKey(recoveryKey) {
    clearRecoveryKey();
    $('recovery-key-value').textContent = recoveryKey;
    $('recovery-dialog').showModal();
  }

  function renderRecovery() {
    const hasKey = Boolean(vaultStatus.recoveryKey);
    $('recovery-reminder').hidden = hasKey;
    $('recovery-status').textContent = hasKey
      ? 'You have a recovery key. Creating a new one stops the old key from working. Backups saved earlier still open with the key and password they were saved with.'
      : 'You don’t have a recovery key yet. Create one so you can get back in if you forget your password.';
    $('replace-recovery-key').textContent = hasKey ? 'Create a new recovery key' : 'Create recovery key';
    $('device-reset-setting').hidden = !vaultStatus.deviceResetSupported;
    $('device-reset-toggle').checked = Boolean(vaultStatus.deviceReset);
  }

  function showView(view, { skipConfirmation = false, focus = true } = {}) {
    if (!viewNames[view] || !vaultStatus.unlocked) return;
    if (!skipConfirmation && currentView === 'profile' && view !== 'profile' && view !== 'documents' && profileDirty) {
      if (!window.confirm('Leave without saving your profile changes?')) return;
      fillProfile();
    }
    if (view !== 'profile') closeSetup();
    if (currentView === 'documents' && view !== 'documents') clearDocumentReview();
    currentView = view;
    for (const key of Object.keys(viewNames)) $(`view-${key}`).hidden = key !== view;
    document.querySelectorAll('.nav-item').forEach((item) => {
      const selected = item.dataset.view === view;
      item.classList.toggle('active', selected);
      if (selected) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
    if (focus) { $('main-content').focus(); window.scrollTo(0, 0); }
    return true;
  }

  // A profile field's input or select, or its radio buttons: setting a group's value checks that answer.
  const profileControl = (field) => $('profile-form').elements.namedItem(field);

  function fillProfile() {
    profileRevision++;
    manualCounts = null;
    for (const key of profileFields) profileControl(key).value = typeof data.profile[key] === 'string' ? data.profile[key] : '';
    renderMembers(Array.isArray(data.profile.householdMembers) ? data.profile.householdMembers : []);
    setProfileDirty(false);
  }

  // Why a birth date can't be used on this computer's calendar today: 'future', 'tooOld' (more than 130
  // years ago), or null. The desktop checks a date the same way when it is saved (#135).
  function dateProblem(birthDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate || '');
    if (!match) return null;
    const now = new Date();
    const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
    const birth = match.slice(1).map(Number);
    const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    if (compare(birth, today) > 0) return 'future';
    if (compare(birth, [today[0] - 130, today[1], today[2]]) < 0) return 'tooOld';
    return null;
  }
  // Whole years on this computer's calendar today; a birthday counts on the day itself. Null without a date
  // or with one that can't be used.
  function ageOn(birthDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate || '');
    if (!match || dateProblem(birthDate)) return null;
    const now = new Date();
    const [year, month, day] = match.slice(1).map(Number);
    return now.getFullYear() - year - (now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day) ? 1 : 0);
  }

  const memberRows = () => Array.from($('household-members').querySelectorAll('.household-member'));
  function memberField(member, field, label, control) {
    const wrap = element('div', 'field');
    const id = `member-${member.id}-${field}`;
    const name = element('label', '', label); name.htmlFor = id;
    control.id = id;
    control.dataset.memberField = field;
    wrap.append(name, control);
    return wrap;
  }
  function choice(options, value) {
    const select = element('select');
    for (const [optionValue, text] of options) { const option = element('option', '', text); option.value = optionValue; select.append(option); }
    select.value = value;
    return select;
  }
  // One person's row. The applicant's own name and birth date come from About you and show here read-only.
  function memberRow(member) {
    const self = member.relationship === 'self';
    const row = element('fieldset', 'household-member');
    row.dataset.memberId = member.id;
    row.dataset.self = String(self);
    const grid = element('div', 'field-grid three');
    // `mirrored`: the applicant's own name and birth date, shown read-only from About you.
    const text = (field, max, type = 'text', mirrored = false) => {
      const input = element('input'); input.type = type; input.value = member[field] || ''; input.autocomplete = 'off';
      if (max) input.maxLength = max;
      if (mirrored) { input.readOnly = true; input.tabIndex = -1; }
      return input;
    };
    grid.append(memberField(member, 'firstName', 'First name', text('firstName', 100, 'text', self)), memberField(member, 'lastName', 'Last name', text('lastName', 100, 'text', self)),
      memberField(member, 'birthDate', 'Date of birth', text('birthDate', 0, 'date', self)));
    if (!self) grid.append(memberField(member, 'relationship', 'How they are related to you', choice([['', 'Choose one'], ...RELATIONSHIPS], member.relationship || '')));
    const student = memberField(member, 'student', 'A student?', choice([['', 'Not answered yet'], ['yes', 'Yes'], ['no', 'No']], member.student || ''));
    const grade = memberField(member, 'grade', 'Grade (for example 3rd, K, or College)', text('grade', 20));
    grade.hidden = member.student !== 'yes';
    student.querySelector('select').addEventListener('change', () => {
      const yes = student.querySelector('select').value === 'yes';
      grade.hidden = !yes;
      if (!yes) grade.querySelector('input').value = '';
    });
    grid.append(student, grade);
    row.append(element('legend'), grid);
    if (self) row.append(element('p', 'field-hint', 'Your name and date of birth come from About you.'));
    row.querySelectorAll('[data-member-field="birthDate"]').forEach(input => input.addEventListener('input', renderCounts));
    return row;
  }
  // The list's rows, legends, remove buttons and Add button, and the counts worked out from it.
  function renderMembers(members) {
    $('household-members').replaceChildren(...members.map(memberRow));
    refreshMembers();
  }
  function refreshMembers() {
    const rows = memberRows();
    rows.forEach((row, index) => {
      const self = row.dataset.self === 'true';
      row.querySelector('legend').textContent = self ? 'You' : `Person ${index + 1}`;
      row.querySelector(':scope > .remove-member')?.remove();
      // The applicant stays on the list while anyone else is on it; alone, removing them removes the list.
      if (self && rows.length > 1) return;
      const remove = element('button', 'text-button danger remove-member', self ? 'Remove the list' : 'Remove this person');
      remove.type = 'button';
      if (!self) remove.setAttribute('aria-label', `Remove person ${index + 1}`);
      remove.addEventListener('click', () => { row.remove(); refreshMembers(); profileRevision++; setProfileDirty(true); });
      row.append(remove);
    });
    $('add-household-member').disabled = rows.length >= MAX_MEMBERS;
    $('household-limit').hidden = rows.length < MAX_MEMBERS;
    syncSelf();
  }
  // The applicant's own row shows their name and birth date as About you has them now.
  function syncSelf() {
    const row = memberRows().find(item => item.dataset.self === 'true');
    if (row) for (const field of ['firstName', 'lastName', 'birthDate']) row.querySelector(`[data-member-field="${field}"]`).value = profileControl(field).value.trim();
    renderCounts();
  }
  function collectMembers() {
    return memberRows().map(row => {
      const self = row.dataset.self === 'true';
      const value = field => row.querySelector(`[data-member-field="${field}"]`)?.value.trim() ?? '';
      const student = value('student');
      return { id: row.dataset.memberId, firstName: self ? profileControl('firstName').value.trim() : value('firstName'),
        lastName: self ? profileControl('lastName').value.trim() : value('lastName'), birthDate: self ? profileControl('birthDate').value.trim() : value('birthDate'),
        relationship: self ? 'self' : value('relationship'), student, grade: student === 'yes' ? value('grade') : '' };
    });
  }
  // With people on the list, the household counts are worked out from it and shown read-only; the
  // desktop works them out the same way. Without the list, the manual counts are the applicant's to enter.
  function renderCounts() {
    const members = collectMembers();
    const listed = members.length > 0;
    if (listed && !manualCounts) manualCounts = Object.fromEntries(COUNT_FIELDS.map(field => [field, profileControl(field).value]));
    if (!listed && manualCounts) { for (const field of COUNT_FIELDS) profileControl(field).value = manualCounts[field]; manualCounts = null; }
    for (const field of COUNT_FIELDS) profileControl(field).readOnly = listed;
    $('household-counts-note').hidden = !listed;
    if (!listed) return;
    const ages = members.map(member => ageOn(member.birthDate));
    const known = ages.every(age => age !== null);
    const count = (low, high) => known ? String(ages.filter(age => age >= low && age <= high).length) : '';
    profileControl('householdSize').value = String(members.length);
    profileControl('householdAdults').value = count(18, 64);
    profileControl('householdChildren').value = count(0, 17);
    profileControl('householdSeniors').value = count(65, Infinity);
    // A birth date after today or more than 130 years ago: whose it is, named as its row is.
    const unusable = members.findIndex(member => dateProblem(member.birthDate));
    const whose = unusable < 0 ? '' : members[unusable].relationship === 'self' ? 'Your' : `Person ${unusable + 1}’s`;
    const when = unusable < 0 ? '' : dateProblem(members[unusable].birthDate) === 'future' ? 'after today' : 'more than 130 years ago';
    $('household-counts-note').textContent = unusable >= 0 ? `Counted from your household list. ${whose} date of birth is ${when}, so ages can’t be counted. Check the date.`
      : known ? 'Counted from your household list. To change them, change the list.'
      : 'Counted from your household list. Add every person’s birth date to count their ages.';
  }
  function addMember() {
    const rows = memberRows();
    if (rows.length >= MAX_MEMBERS) return;
    const blank = relationship => ({ id: window.crypto.randomUUID(), firstName: '', lastName: '', birthDate: '', relationship, student: '', grade: '' });
    // The list starts with the applicant.
    if (!rows.length) $('household-members').append(memberRow(blank('self')));
    const row = memberRow(blank(''));
    $('household-members').append(row);
    refreshMembers();
    profileRevision++;
    setProfileDirty(true);
    row.querySelector('[data-member-field="firstName"]').focus();
  }

  // The guided setup on screen: one step's cards, its title, and Back, Finish later, and Save and continue.
  function renderSetupStep() {
    const active = setupStep !== null;
    // Each section of My information belongs to one step; a card shows while any of its sections does.
    for (const part of $('profile-form').querySelectorAll('[data-setup-step]')) part.hidden = active && Number(part.dataset.setupStep) !== setupStep + 1;
    for (const card of $('profile-form').querySelectorAll(':scope > .form-card')) {
      card.hidden = active && !card.matches('[data-setup-step]:not([hidden])') && !card.querySelector('[data-setup-step]:not([hidden])');
      // A card split across steps shows one part at a time: the step's own title names it.
      const heading = card.querySelector(':scope > .card-heading');
      if (heading && !card.matches('[data-setup-step]')) heading.hidden = active;
    }
    $('setup-bar').hidden = !active;
    $('setup-nav').hidden = !active;
    $('save-profile').closest('.form-save-bar').hidden = active;
    $('profile-heading').textContent = active ? 'Set up your information' : 'My information';
    if (!active) return;
    const step = SETUP_STEPS[setupStep];
    $('setup-step-count').textContent = `Step ${setupStep + 1} of ${SETUP_STEPS.length}`;
    $('setup-step-title').textContent = step.title;
    $('setup-step-intro').textContent = step.intro;
    $('setup-progress').value = setupStep;
    $('setup-back').disabled = setupStep === 0;
    $('setup-next-label').textContent = setupStep === SETUP_STEPS.length - 1 ? 'Save and finish' : 'Save and continue';
    window.scrollTo(0, 0);
    $('setup-step-title').focus();
  }
  function openSetup() {
    if (!setupProgress || !showView('profile')) return;
    setupStep = Math.min(setupProgress.step, SETUP_STEPS.length - 1);
    renderSetupStep();
  }
  function closeSetup() {
    if (setupStep === null) return;
    setupStep = null;
    renderSetupStep();
  }
  // Overview's "Finish setting up" while a setup is under way.
  function renderSetupResume() {
    $('setup-resume').hidden = !setupProgress;
    $('setup-resume-text').textContent = setupProgress ? `Finish setting up: ${setupProgress.step} of ${SETUP_STEPS.length} steps` : '';
  }
  // A step saved: the desktop records it, then the next step shows, or after the last, Overview.
  async function setupStepSaved(step, generation) {
    const progress = await api.saveSetupProgress(step + 1);
    if (generation !== vaultGeneration || !vaultStatus.unlocked) return;
    setupProgress = progress;
    renderSetupResume();
    if (setupStep !== step) return;
    if (step + 1 < SETUP_STEPS.length) { setupStep = step + 1; renderSetupStep(); return; }
    closeSetup();
    showView('overview', { skipConfirmation: true });
    toast('Your information is set up. Change it any time in My information.');
  }

  // Save to My information in Chrome changed these saved fields. My information shows the new answers;
  // a field the applicant is editing keeps their unsaved edit.
  async function profileChangedElsewhere(fields) {
    if (!vaultStatus.unlocked) return;
    const generation = vaultGeneration;
    try {
      const latest = await api.getData();
      if (generation !== vaultGeneration || !vaultStatus.unlocked) return;
      const before = data.profile;
      data = { ...data, profile: latest.profile || {} };
      if (!profileDirty) fillProfile();
      else for (const field of fields.filter(name => profileFields.includes(name))) {
        if (String(profileControl(field).value) === String(before[field] ?? '')) profileControl(field).value = typeof data.profile[field] === 'string' ? data.profile[field] : '';
      }
      renderSummary();
      toast('An answer you saved from Chrome is now in My information.');
    } catch (error) { if (generation === vaultGeneration) toast(error.message || 'Unable to show the answer you saved from Chrome.', true); }
  }

  function documentControls() {
    $('read-document').disabled = documentBusy || !api?.readDocument;
    $('read-document').setAttribute('aria-busy', String(documentBusy));
    $('read-document').querySelector('span').textContent = documentFields.length || !$('document-review').hidden ? 'Choose another document' : 'Choose PDF or photo';
    $('document-progress-card').hidden = !documentBusy;
    const selected = documentFields.filter(field => field.checkbox?.checked);
    $('document-selection-count').textContent = selected.length ? `${selected.length} ${selected.length === 1 ? 'detail' : 'details'} selected · profile draft only` : 'No details selected. Nothing will be changed.';
    $('apply-document-fields').disabled = documentBusy || !selected.length || !$('document-confirm-applicant').checked || !vaultStatus.unlocked;
  }

  function clearDocumentReview({ cancel = true } = {}) {
    const requestId = documentRequestId;
    const wasBusy = documentBusy;
    documentRevision++;
    documentRequestId = null;
    documentBusy = false;
    if (stopDocumentProgress) { try { stopDocumentProgress(); } catch { /* Cleared generation still blocks late events. */ } }
    stopDocumentProgress = null;
    documentFields = [];
    for (const id of ['document-fields', 'document-pages', 'document-warning-list']) $(id).replaceChildren();
    for (const id of ['document-name', 'document-type', 'document-page-summary', 'document-status', 'document-progress-label']) $(id).textContent = '';
    $('document-review').hidden = true;
    $('document-empty').hidden = false;
    $('document-warnings').hidden = true;
    $('document-no-fields').hidden = true;
    $('document-draft-note').hidden = true;
    $('document-raw').open = false;
    $('document-confirm-applicant').checked = false;
    $('document-progress').removeAttribute('value');
    clearError('document-error');
    documentControls();
    if (cancel && wasBusy && requestId && api?.cancelDocumentRead) {
      Promise.resolve().then(() => api.cancelDocumentRead(requestId)).catch(() => { /* Lock/navigation must still clear local text. */ });
    }
  }

  const documentText = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
  const confidenceText = confidence => typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 100
    ? `${Math.round(confidence)}% recognition confidence` : 'Recognition confidence unavailable';
  function documentCurrent(field) {
    field.current = String(profileControl(field.key).value || '');
    field.currentValue.textContent = field.current || 'Blank';
  }

  function renderDocument(result) {
    if (!result || typeof result.name !== 'string' || !Array.isArray(result.pages)) throw new Error('This document could not be displayed. Try reading it again.');
    const pages = result.pages.slice(0, 100);
    const analysis = result.analysis || {};
    $('document-name').textContent = documentText(result.name, 250);
    const title = documentText(analysis.title, 150) || 'Document type not recognized';
    const year = /^\d{4}$/.test(String(analysis.taxYear || '')) ? ` · Tax year ${analysis.taxYear}` : '';
    $('document-type').textContent = title + year;
    $('document-page-summary').textContent = `${Number.isInteger(result.pageCount) && result.pageCount > 0 ? result.pageCount : pages.length} ${(result.pageCount || pages.length) === 1 ? 'page' : 'pages'} read · Compare every detail with the original`;
    $('document-draft-note').hidden = !profileDirty;
    const warnings = Array.isArray(analysis.warnings) ? analysis.warnings.filter(value => typeof value === 'string').slice(0, 100).map(value => documentText(value)) : [];
    for (const [index, page] of pages.entries()) {
      const number = Number.isInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : index + 1;
      const text = typeof page.text === 'string' ? page.text : '';
      const unreadable = !text.trim();
      const low = typeof page.confidence === 'number' && page.confidence >= 0 && page.confidence < 70;
      if (unreadable) warnings.push(`Page ${number}: no readable text was found. Check the original or try a clearer image.`);
      else if (low) warnings.push(`Page ${number}: recognition confidence is low. Check its text carefully against the original.`);
      const details = element('details', `document-page${unreadable || low ? ' unreadable' : ''}`);
      const summary = element('summary', '', `Page ${number} · ${unreadable ? 'No readable text' : confidenceText(page.confidence)}`);
      details.append(summary, element('pre', '', unreadable ? 'No readable text found on this page.' : text));
      $('document-pages').append(details);
    }
    for (const warning of [...new Set(warnings)]) $('document-warning-list').append(element('li', '', warning));
    $('document-warnings').hidden = !warnings.length;
    const fields = Array.isArray(analysis.fields) ? analysis.fields.slice(0, 150) : [];
    for (const [index, field] of fields.entries()) {
      if (!field || typeof field.value !== 'string' || !field.value.trim() || typeof field.label !== 'string') continue;
      const key = documentProfileKeys.has(field.profileKey) ? field.profileKey : null;
      const eligible = Boolean(key && field.value.length <= 200);
      const row = element('div', `document-field${eligible ? '' : ' review-only'}`);
      row.dataset.fieldId = documentText(field.id, 80) || `detail-${index}`;
      const label = element(eligible ? 'label' : 'div', 'document-field-label', documentText(field.label, 150));
      const page = Number.isInteger(field.page) && field.page > 0 ? `Page ${field.page} · ` : '';
      label.append(element('span', 'document-field-source', page + confidenceText(field.confidence)));
      const values = element('div', 'document-field-value');
      if (eligible) {
        const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.id = `document-select-${index}`;
        checkbox.dataset.profileKey = key;
        label.htmlFor = checkbox.id;
        const input = element('input'); input.type = 'text'; input.maxLength = 200; input.autocomplete = 'off'; input.spellcheck = false;
        input.value = field.value; input.setAttribute('aria-label', `Document value for ${documentText(field.label, 150)}`);
        const current = element('div', 'document-current'); current.append(element('span', '', 'Current profile draft'));
        const currentValue = element('div'); current.append(currentValue);
        const record = { key, checkbox, input, currentValue, current: '' };
        documentCurrent(record);
        documentFields.push(record);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            for (const other of documentFields) if (other !== record && other.key === key) other.checkbox.checked = false;
            documentCurrent(record);
          }
          $('document-confirm-applicant').checked = false;
          documentControls();
        });
        input.addEventListener('input', () => { $('document-confirm-applicant').checked = false; documentControls(); });
        values.append(input);
        row.append(checkbox, label, values, current);
      } else {
        values.append(element('strong', '', documentText(field.value, 500)));
        row.append(label, values, element('span', 'document-review-only', 'Review only · not added to profile'));
      }
      $('document-fields').append(row);
    }
    $('document-no-fields').hidden = $('document-fields').childElementCount > 0;
    $('document-empty').hidden = true;
    $('document-review').hidden = false;
    $('document-status').textContent = 'Read locally. No information has been saved or shared.';
    documentControls();
  }

  async function readDocument() {
    if (documentBusy || !vaultStatus.unlocked || currentView !== 'documents' || !api?.readDocument) return;
    clearDocumentReview();
    const generation = vaultGeneration;
    const revision = documentRevision;
    const requestId = window.crypto.randomUUID();
    documentRequestId = requestId;
    documentBusy = true;
    $('document-empty').hidden = true;
    $('document-status').textContent = 'Choose a document in the file picker. Nothing is uploaded.';
    $('document-progress-label').textContent = 'Opening your document…';
    documentControls();
    const current = () => vaultStatus.unlocked && generation === vaultGeneration && revision === documentRevision && documentRequestId === requestId && currentView === 'documents';
    if (api.onDocumentProgress) stopDocumentProgress = api.onDocumentProgress(progress => {
      if (!current() || progress?.requestId !== requestId) return;
      const phases = { loading: 'Preparing local text recognition', rendering: 'Preparing page', recognizing: 'Reading page' };
      const phase = phases[progress.phase] || 'Reading document';
      const page = Number.isInteger(progress.page) && progress.page > 0 ? progress.page : 0;
      const total = Number.isInteger(progress.total) && progress.total > 0 ? progress.total : 0;
      $('document-progress-label').textContent = page && total ? `${phase} ${page} of ${total}…` : `${phase}…`;
      if (page && total && page <= total) $('document-progress').value = Math.min(99, Math.round((page - 1) / total * 100));
      else $('document-progress').removeAttribute('value');
      $('document-status').textContent = 'Reading locally. Your document stays on this computer.';
    });
    try {
      const response = await api.readDocument(requestId);
      if (!current()) return;
      if (response?.cancelled) {
        clearDocumentReview({ cancel: false });
        $('document-status').textContent = 'Reading cancelled. No document text was retained.';
      } else renderDocument(response?.document);
    } catch (error) {
      if (current()) {
        clearDocumentReview({ cancel: false });
        showError('document-error', error);
      }
    } finally {
      if (current()) {
        if (stopDocumentProgress) stopDocumentProgress();
        stopDocumentProgress = null;
        documentRequestId = null;
        documentBusy = false;
        documentControls();
      }
    }
  }

  function applyDocumentFields() {
    if (!vaultStatus.unlocked || currentView !== 'documents' || $('apply-document-fields').disabled) return;
    const selected = documentFields.filter(field => field.checkbox.checked);
    if (!selected.length || !$('document-confirm-applicant').checked) return;
    if (selected.some(field => String(profileControl(field.key).value || '') !== field.current)) {
      for (const field of documentFields) { documentCurrent(field); field.checkbox.checked = false; }
      $('document-confirm-applicant').checked = false;
      $('document-status').textContent = 'Your profile draft changed during review. Check the current values and select the details again.';
      documentControls();
      return;
    }
    for (const field of selected) profileControl(field.key).value = field.input.value.trim();
    profileRevision++;
    setProfileDirty(true);
    showView('profile', { skipConfirmation: true });
    toast(`${selected.length} ${selected.length === 1 ? 'detail added' : 'details added'} to your profile draft. Review and save when ready.`);
  }

  function dateLabel(value) {
    if (!value) return '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function sortedApplications() {
    return [...data.applications].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  function badge(status) { return element('span', `badge ${statusNames[status] ? status : 'draft'}`, statusNames[status] || 'Draft'); }

  function renderApplications() {
    $('application-count').textContent = String(data.applications.length);
    const list = $('application-list');
    const overview = $('overview-applications');
    list.replaceChildren();
    overview.replaceChildren();
    if (!data.applications.length) {
      const empty = element('div', 'empty-state');
      const emptyIcon = element('span', 'card-icon'); emptyIcon.append(icon('file'));
      const add = element('button', 'button button-primary', 'Add my first application');
      add.type = 'button'; add.addEventListener('click', () => openApplication());
      empty.append(emptyIcon, element('h2', '', 'No applications yet'), element('p', '', 'Add an Iowa SNAP application record to keep track of progress, agency requests, and your next step.'), add);
      list.append(empty);
      const compact = element('div', 'overview-empty');
      const copy = element('div');
      copy.append(element('h3', '', 'No applications yet'), element('p', '', 'When you add an application, you’ll see it here.'));
      compact.append(icon('file'), copy); overview.append(compact);
      return;
    }
    for (const application of sortedApplications()) {
      const card = element('article', 'application-card');
      const header = element('div', 'application-card-header');
      const title = element('div', 'application-card-title');
      const mark = element('span', 'card-icon'); mark.append(icon('file'));
      const titleText = element('div');
      titleText.append(element('h3', '', 'Iowa SNAP'), element('p', 'application-meta', dateLabel(application.createdAt) ? `Started ${dateLabel(application.createdAt)}` : 'Start date not recorded'));
      title.append(mark, titleText); header.append(title, badge(application.status)); card.append(header);
      if (application.nextAction || application.dueDate) {
        const details = element('div', 'application-details');
        if (application.nextAction) {
          const action = element('div'); action.append(element('span', 'detail-label', 'NEXT ACTION'), element('p', '', application.nextAction)); details.append(action);
        }
        if (application.dueDate) {
          const due = element('div', 'due-detail'); due.append(element('span', 'detail-label', 'DUE DATE'), element('p', '', dateLabel(application.dueDate))); details.append(due);
        }
        card.append(details);
      }
      const footer = element('div', 'application-card-footer');
      const edit = element('button', 'text-button', 'View & update'); edit.type = 'button'; edit.append(icon('arrow')); edit.addEventListener('click', () => openApplication(application));
      footer.append(edit); card.append(footer); list.append(card);
    }
    for (const application of sortedApplications().slice(0, 3)) {
      const row = element('button', 'overview-app-row'); row.type = 'button';
      const content = element('div'); content.append(element('strong', '', 'Iowa SNAP'), element('p', '', application.nextAction || 'Add a next step when you’re ready.'));
      row.append(content, badge(application.status)); row.addEventListener('click', () => openApplication(application)); overview.append(row);
    }
  }

  function renderSetup() {
    const connected = Boolean(vaultStatus.extensionId);
    const setup = vaultStatus.extensionSetup || {};
    const bundled = connected && vaultStatus.extensionId === setup.extensionId;
    $('extension-id').value = vaultStatus.extensionId || '';
    $('autofill-trust').checked = Boolean(vaultStatus.autofillWithoutAsking);
    renderTrustedSites();
    renderAllSites();
    renderLaya();
    $('extension-status').textContent = bundled ? (setup.prepared ? 'Ready to load in Chrome' : 'Setup needs refresh') : connected ? 'Custom connection registered' : 'Needs setup';
    $('extension-status').classList.toggle('connected', connected);
    $('extension-prepared').hidden = !setup.prepared;
    $('extension-folder-path').textContent = setup.prepared ? setup.directory : '';
    $('prepare-extension').replaceChildren(document.createTextNode(setup.prepared || bundled ? 'Refresh extension files ' : 'Prepare Chrome extension '), icon('plug'));
    $('extension-folder-help').textContent = vaultStatus.platform === 'darwin'
      ? 'In Chrome’s folder chooser, press Command + Shift + G, paste the copied folder path, then choose Open and Select.'
      : 'In Chrome’s folder chooser, paste the copied folder path into the address bar, then choose Select Folder.';
    $('extension-step-label').replaceChildren(document.createTextNode(connected ? 'Manage connection ' : 'Set up extension '), icon('arrow'));
  }

  const megabytes = bytes => `${Math.round(bytes / 1e6)} MB`;

  // Laya's model status in the Chrome extension view: off, unavailable, not downloaded (or
  // paused), downloading, ready, or error, then what its update check said or an update's progress.
  // Progress is polled while a download or an update download runs.
  function renderLaya(laya = vaultStatus.laya || { state: 'off', enabled: false }) {
    const size = laya.sizeBytes ? megabytes(laya.sizeBytes) : '';
    const percent = Math.floor((laya.progress || 0) * 100);
    const text = {
      off: size ? `Off. The model is a ${size} download that runs on this computer.` : 'Off.',
      unavailable: laya.message,
      'not-downloaded': percent > 0 ? `Download paused at ${percent}% of ${size}.` : `Not downloaded (${size}).`,
      downloading: `Downloading ${percent}% of ${size}…`,
      ready: size ? `Ready. The model (${size}) is on this computer.` : 'Ready.',
      error: laya.message
    }[laya.state];
    const update = laya.update;
    const updating = update?.state === 'downloading';
    const note = updating ? `Downloading an update: ${Math.floor((update.progress || 0) * 100)}% of ${megabytes(update.sizeBytes)}…` : update?.message;
    $('laya-toggle').checked = Boolean(laya.enabled) && laya.state !== 'unavailable';
    $('laya-toggle').disabled = laya.state === 'unavailable';
    $('laya-status').textContent = [text, note].filter(Boolean).join(' ');
    const paused = laya.state === 'not-downloaded' && percent > 0;
    $('laya-progress').hidden = !(laya.state === 'downloading' || paused);
    $('laya-progress').value = percent;
    $('laya-download').hidden = !['not-downloaded', 'error'].includes(laya.state);
    $('laya-download').textContent = laya.state === 'error' ? 'Try again' : paused ? 'Resume download' : 'Download model';
    $('laya-cancel').hidden = laya.state !== 'downloading';
    $('laya-remove').hidden = !['ready', 'error'].includes(laya.state);
    clearTimeout(layaPoll);
    if (laya.state === 'downloading' || updating) {
      const generation = vaultGeneration;
      layaPoll = setTimeout(() => {
        api.layaStatus().then(status => { if (generation === vaultGeneration) showLaya(status); },
          error => { if (generation === vaultGeneration) showError('laya-error', error); });
      }, LAYA_POLL_MS);
    }
  }

  function showLaya(laya) {
    vaultStatus = { ...vaultStatus, laya };
    renderLaya(laya);
  }

  function renderTrustedSites() {
    const sites = Array.isArray(vaultStatus.trustedSites) ? vaultStatus.trustedSites : [];
    $('trusted-sites').replaceChildren(...sites.map(origin => {
      const row = element('li', 'trusted-site');
      const remove = element('button', 'text-button', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        const generation = vaultGeneration;
        pending(remove, async () => {
          try {
            const status = await api.removeTrustedSite(origin);
            if (generation !== vaultGeneration) return;
            vaultStatus = { ...vaultStatus, ...status }; renderTrustedSites();
            toast(`SecondHand will no longer fill forms on ${origin}.`);
          } catch (error) { if (generation === vaultGeneration) showError('autofill-trust-error', error); }
        });
      });
      row.append(element('code', '', origin), remove);
      return row;
    }));
    $('trusted-sites-empty').hidden = sites.length > 0;
  }

  // SecondHand on all websites. Only the extension can turn it on: Chrome asks for access to every
  // site inside a click in its side panel. This app can turn it off.
  function renderAllSites() {
    const on = vaultStatus.allSites === true;
    $('all-sites-status').textContent = on
      ? 'All websites: on. SecondHand can fill forms on any website after you click Autofill there. Sensitive details still ask on each site.'
      : 'All websites: off. To turn it on, open SecondHand’s side panel in Chrome and choose Use SecondHand on all websites.';
    $('all-sites-off').hidden = !on;
  }

  function renderSummary() {
    const hasProfile = profileFields.some((field) => Boolean(data.profile[field]));
    $('profile-step-label').replaceChildren(document.createTextNode(hasProfile ? 'Review my profile ' : 'Set up my profile '), icon('arrow'));
    renderApplications(); renderSetup(); renderRecovery(); renderTouchId();
  }

  async function loadUnlocked(status) {
    const generation = vaultGeneration;
    const [loaded, progress] = await Promise.all([api.getData(), api.setupProgress().then(value => ({ value }), error => ({ error }))]);
    if (generation !== vaultGeneration) return;
    // A successful unlock can supersede a delayed event for a lock that the
    // desktop already completed before this authenticated status was returned.
    if (Number.isSafeInteger(status.lockRevision) && status.lockRevision >= 0) {
      handledLockRevision = Math.max(handledLockRevision, status.lockRevision);
    }
    vaultStatus = status;
    data = { profile: loaded.profile || {}, applications: Array.isArray(loaded.applications) ? loaded.applications : [] };
    $('auth-form').reset();
    $('reset-form').reset();
    $('auth-view').hidden = true;
    $('workspace').hidden = false;
    setupProgress = progress.value || null;
    fillProfile(); renderSummary();
    showView('overview', { skipConfirmation: true });
    renderSetupResume();
    // Problems found while opening, in one toast so neither hides the other: setup progress that
    // couldn't be read, and Touch ID turned off while unlocking (and why).
    const problems = [progress.error && (progress.error.message || 'SecondHand couldn’t read your setup progress.'),
      typeof status.touchIdNotice === 'string' && status.touchIdNotice].filter(Boolean);
    if (problems.length) toast(problems.join(' '), true);
  }

  async function lockVault() {
    if (profileDirty && !window.confirm('Lock SecondHand and discard your unsaved changes?')) return;
    const generation = vaultGeneration;
    try {
      const status = await api.lock();
      // The lock notification can arrive before the IPC response finishes
      // gathering status. Do not reset a form the user has already started using.
      if (generation === vaultGeneration) showLocked(status);
    } catch (error) { toast(error.message || 'Unable to lock SecondHand.', true); }
  }

  function openApplication(application = null) {
    if (!vaultStatus.unlocked) return;
    $('application-form').reset(); clearError('application-error');
    $('application-id').value = application?.id || '';
    $('application-dialog-title').textContent = application ? 'Update application' : 'Add an application';
    $('application-status').value = application?.status || 'draft';
    $('application-confirmation').value = application?.confirmationNumber || '';
    $('application-next-action').value = application?.nextAction || '';
    $('application-due-date').value = application?.dueDate || '';
    $('application-notes').value = application?.notes || '';
    $('delete-application').hidden = !application;
    $('application-confirmation').required = $('application-status').value === 'submitted';
    $('application-dialog').showModal();
  }

  async function refreshApplications(generation) {
    if (!vaultStatus.unlocked || generation !== vaultGeneration) return false;
    const revision = ++applicationRefreshRevision;
    const latest = await api.getData();
    if (!vaultStatus.unlocked || generation !== vaultGeneration) return false;
    // A newer refresh owns the list. Still report a valid unlocked generation
    // to save/delete callers so their completed operation can close its editor.
    if (revision !== applicationRefreshRevision) return true;
    data.applications = Array.isArray(latest.applications) ? latest.applications : [];
    renderApplications();
    return true;
  }

  $('auth-form').addEventListener('submit', (event) => {
    event.preventDefault(); clearError('auth-error');
    if (!api) return;
    if (!vaultStatus.exists && $('passphrase').value !== $('confirm-passphrase').value) {
      showError('auth-error', 'The passwords don’t match. Please try again.'); $('confirm-passphrase').focus(); return;
    }
    const generation = vaultGeneration;
    pending($('auth-submit'), async () => {
      try {
        if (vaultStatus.exists) {
          const status = await api.unlock($('passphrase').value);
          if (generation !== vaultGeneration) return;
          await loadUnlocked(status);
        } else {
          const allowDeviceReset = !$('device-reset-field').hidden && $('allow-device-reset').checked;
          const created = await api.createVault({ password: $('passphrase').value, allowDeviceReset });
          if (generation !== vaultGeneration) return;
          await loadUnlocked(created.status);
          if (generation !== vaultGeneration) return;
          // The guided setup starts with the new password, so it can be resumed; it is offered after the recovery key.
          setupProgress = await api.startSetup();
          if (generation !== vaultGeneration) return;
          renderSetupResume();
          offerSetup = true;
          showRecoveryKey(created.recoveryKey);
          if (created.deviceResetFailed) $('recovery-feedback').textContent = 'This computer couldn’t save a reset option, so keep this key safe.';
        }
      } catch (error) { if (generation === vaultGeneration) showError('auth-error', error); }
      finally {
        if (generation === vaultGeneration) { $('passphrase').value = ''; $('confirm-passphrase').value = ''; }
      }
    });
  });

  // The prompt is macOS's own. A refusal says why and leaves the password field ready.
  $('touch-id-unlock').addEventListener('click', () => {
    if (!api) return;
    clearError('auth-error');
    const generation = vaultGeneration;
    pending($('touch-id-unlock'), async () => {
      try {
        const status = await api.unlockWithTouchId();
        if (generation !== vaultGeneration) return;
        await loadUnlocked(status);
      } catch (error) {
        if (generation !== vaultGeneration) return;
        showError('auth-error', error);
        $('passphrase').focus();
        await refreshTouchIdUnlock();
      }
    });
  });

  $('forgot-password').addEventListener('click', () => setResetMode(true));
  $('reset-cancel').addEventListener('click', () => showLocked(vaultStatus, { refresh: true }));
  $('start-over').addEventListener('click', () => setStartOverMode(true));
  $('start-over-cancel').addEventListener('click', () => setResetMode(true));
  $('start-over-confirm').addEventListener('input', () => { $('start-over-submit').disabled = !startOverConfirmed(); });
  $('start-over-save').addEventListener('click', () => {
    if (!api) return;
    pending($('start-over-save'), async () => {
      clearError('start-over-error');
      try {
        const result = await api.exportBackup();
        if (!result.cancelled) toast('Locked copy saved. You can restore it with your old password.');
      } catch (error) { showError('start-over-error', error); }
    });
  });
  $('start-over-form').addEventListener('submit', (event) => {
    event.preventDefault(); clearError('start-over-error');
    if (!api || !startOverConfirmed()) return;
    pending($('start-over-submit'), async () => {
      try {
        const status = await api.startOver({ confirmation: $('start-over-confirm').value });
        // Erasing changes whether a vault exists without a lock transition.
        showLocked(status, { refresh: true });
        toast('Your saved information was erased. Create a new password to start again.');
      } catch (error) { showError('start-over-error', error); }
    });
  });
  $('reset-form').addEventListener('submit', (event) => {
    event.preventDefault(); clearError('reset-error');
    if (!api) return;
    if ($('reset-password').value !== $('reset-confirm').value) {
      showError('reset-error', 'The passwords don’t match. Please try again.'); $('reset-confirm').focus(); return;
    }
    const generation = vaultGeneration;
    pending($('reset-submit'), async () => {
      try {
        const password = $('reset-password').value;
        const status = await api.resetPassword(resetWithDevice() ? { method: 'device', password } : { recoveryKey: $('recovery-key-input').value, password });
        if (generation !== vaultGeneration) return;
        await loadUnlocked(status);
        if (generation !== vaultGeneration) return;
        toast('Your password was reset. Use your new password next time.');
      } catch (error) { if (generation === vaultGeneration) showError('reset-error', error); }
      finally {
        if (generation === vaultGeneration) { $('reset-password').value = ''; $('reset-confirm').value = ''; }
      }
    });
  });

  document.querySelectorAll('input[name="reset-method"]').forEach((input) => input.addEventListener('change', () => { clearError('reset-error'); renderResetMethod(); }));
  $('device-reset-toggle').addEventListener('change', () => {
    const enabled = $('device-reset-toggle').checked;
    const generation = vaultGeneration;
    $('device-reset-toggle').disabled = true;
    api.setDeviceReset(enabled).then((status) => {
      if (generation !== vaultGeneration) return;
      vaultStatus = status; renderRecovery();
      toast(enabled ? 'This computer can now reset your password.' : 'Reset on this computer is turned off.');
    }).catch((error) => {
      if (generation !== vaultGeneration) return;
      $('device-reset-toggle').checked = !enabled;
      toast(error.message || 'Unable to change this setting.', true);
    }).finally(() => { if (generation === vaultGeneration) $('device-reset-toggle').disabled = false; });
  });
  // Turning Touch ID on asks for the password first, in the app's own dialog; turning it off doesn't.
  $('touch-id-toggle').addEventListener('change', () => {
    const enabled = $('touch-id-toggle').checked;
    if (enabled) {
      $('touch-id-toggle').checked = false;
      closeTouchIdDialog();
      $('touch-id-dialog').showModal();
      $('touch-id-password').focus();
      return;
    }
    const generation = vaultGeneration;
    $('touch-id-toggle').disabled = true;
    api.setTouchIdUnlock({ enabled: false }).then((status) => {
      if (generation !== vaultGeneration) return;
      vaultStatus = status; renderTouchId();
      toast('Touch ID is off. Unlock with your password.');
    }).catch((error) => {
      if (generation !== vaultGeneration) return;
      $('touch-id-toggle').checked = true;
      toast(error.message || 'Unable to change this setting.', true);
    }).finally(() => { if (generation === vaultGeneration) $('touch-id-toggle').disabled = false; });
  });
  $('touch-id-form').addEventListener('submit', (event) => {
    event.preventDefault(); clearError('touch-id-error');
    if (!api) return;
    const generation = vaultGeneration;
    pending($('touch-id-confirm'), async () => {
      try {
        const status = await api.setTouchIdUnlock({ enabled: true, password: $('touch-id-password').value });
        if (generation !== vaultGeneration) return;
        vaultStatus = status; renderTouchId();
        closeTouchIdDialog();
        toast('Touch ID is on. Use it on the lock screen or from SecondHand’s side panel in Chrome.');
      } catch (error) {
        if (generation !== vaultGeneration) return;
        showError('touch-id-error', error);
        $('touch-id-password').select();
      }
    });
  });
  $('touch-id-cancel').addEventListener('click', closeTouchIdDialog);
  $('touch-id-dialog').addEventListener('close', () => { $('touch-id-form').reset(); clearError('touch-id-error'); });
  $('recovery-saved').addEventListener('change', () => { $('recovery-done').disabled = !$('recovery-saved').checked; });
  $('recovery-done').addEventListener('click', () => $('recovery-dialog').close());
  $('recovery-dialog').addEventListener('cancel', (event) => { if (!$('recovery-saved').checked) event.preventDefault(); });
  $('recovery-dialog').addEventListener('close', clearRecoveryKey);
  $('recovery-done').addEventListener('click', () => {
    if (!offerSetup || !vaultStatus.unlocked) return;
    offerSetup = false;
    $('setup-dialog').showModal();
  });
  $('setup-start').addEventListener('click', () => { $('setup-dialog').close(); openSetup(); });
  $('setup-skip').addEventListener('click', () => { $('setup-dialog').close(); showView('overview', { skipConfirmation: true }); renderSetupResume(); });
  $('setup-resume-button').addEventListener('click', openSetup);
  $('setup-back').addEventListener('click', () => { if (setupStep > 0) { setupStep--; renderSetupStep(); } });
  $('setup-later').addEventListener('click', () => { if (showView('overview')) renderSetupResume(); });
  $('add-household-member').addEventListener('click', addMember);
  for (const [buttonId, method, message] of [
    ['copy-recovery-key', 'copyRecoveryKey', 'Copied. It will be cleared from the clipboard in 1 minute.'],
    ['save-recovery-key', 'saveRecoveryKey', 'Saved. Print it or move it somewhere safe, away from this computer.']
  ]) {
    $(buttonId).addEventListener('click', () => pending($(buttonId), async () => {
      try {
        const result = await api[method]($('recovery-key-value').textContent);
        if (!result?.cancelled) $('recovery-feedback').textContent = message;
      } catch (error) { $('recovery-feedback').textContent = error.message || 'That didn’t work. Please try again.'; }
    }));
  }
  $('replace-recovery-key').addEventListener('click', () => {
    if (vaultStatus.recoveryKey && !window.confirm('Create a new recovery key? Your current recovery key will stop working.')) return;
    const generation = vaultGeneration;
    pending($('replace-recovery-key'), async () => {
      try {
        const { recoveryKey } = await api.replaceRecoveryKey();
        if (!vaultStatus.unlocked || generation !== vaultGeneration) return;
        vaultStatus.recoveryKey = true;
        renderRecovery();
        showRecoveryKey(recoveryKey);
      } catch (error) { if (generation === vaultGeneration) toast(error.message || 'Unable to create a recovery key.', true); }
    });
  });

  $('auth-import').addEventListener('click', () => {
    if (!api) return;
    if (vaultStatus.exists && !window.confirm('Restoring replaces the information saved on this computer. Make sure you have a backup of anything you want to keep. Continue?')) return;
    pending($('auth-import'), async () => {
      try {
        const result = await api.importBackup();
        if (result.cancelled) return;
        // Restoring changes whether a vault exists without a lock transition.
        showLocked(await api.status(), { refresh: true });
        toast('Backup restored. Unlock it with the password it was created with.');
      } catch (error) { showError('auth-error', error); }
    });
  });

  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    const view = button.dataset.view;
    if (showView(view) && (view === 'overview' || view === 'applications')) {
      // Native progress may arrive while another desktop view is active. Read
      // fresh application records on navigation without replacing profile edits.
      refreshApplications(vaultGeneration).catch(() => { /* Keep the current list until the next refresh or lock. */ });
    }
  }));
  document.querySelector('.auth-brand').addEventListener('click', (event) => event.preventDefault());
  $('read-document').addEventListener('click', readDocument);
  $('cancel-document').addEventListener('click', () => {
    clearDocumentReview();
    $('document-status').textContent = 'Reading cancelled. No document text was retained. If the file picker is still open, close it to finish cancelling.';
  });
  $('discard-document').addEventListener('click', () => {
    clearDocumentReview();
    $('document-status').textContent = 'Document review discarded. Your profile has not changed.';
  });
  $('document-confirm-applicant').addEventListener('change', documentControls);
  $('apply-document-fields').addEventListener('click', applyDocumentFields);
  documentControls();
  $('overview-start').addEventListener('click', () => showView('profile'));
  $('lock-button').addEventListener('click', lockVault);
  $('privacy-lock').addEventListener('click', lockVault);
  $('profile-form').addEventListener('input', (event) => {
    profileRevision++; setProfileDirty(true);
    if (['firstName', 'lastName', 'birthDate'].includes(event.target.name)) syncSelf();
  });
  $('profile-form').addEventListener('submit', (event) => {
    event.preventDefault(); clearError('profile-error');
    const generation = vaultGeneration;
    const revision = profileRevision;
    // In the guided setup, saving a step moves on to the next.
    const step = setupStep;
    const profile = { ...Object.fromEntries(profileFields.map((field) => [field, profileControl(field).value.trim()])), householdMembers: collectMembers() };
    pending(step === null ? $('save-profile') : $('setup-next'), async () => {
      try {
        const saved = await api.saveProfile(profile);
        if (!vaultStatus.unlocked || generation !== vaultGeneration) return;
        data.profile = saved;
        const newerEdits = profileDirty && profileRevision !== revision;
        if (!newerEdits) fillProfile();
        renderSummary();
        toast(newerEdits ? 'Earlier changes saved. Your newer edits still need to be saved.' : 'Your information is saved on this computer.');
        if (step !== null) await setupStepSaved(step, generation);
      } catch (error) { if (generation === vaultGeneration) showError('profile-error', error); }
    });
  });

  $('new-application').addEventListener('click', () => openApplication());
  const closeApplication = () => { $('application-dialog').close(); $('application-form').reset(); $('application-id').value = ''; clearError('application-error'); };
  $('close-application').addEventListener('click', closeApplication);
  $('cancel-application').addEventListener('click', closeApplication);
  $('application-dialog').addEventListener('cancel', (event) => {
    if (applicationBusy) event.preventDefault();
    else closeApplication();
  });
  $('application-status').addEventListener('change', () => { $('application-confirmation').required = $('application-status').value === 'submitted'; });
  $('application-form').addEventListener('submit', (event) => {
    event.preventDefault(); clearError('application-error');
    const application = {
      id: $('application-id').value,
      program: 'Iowa SNAP',
      status: $('application-status').value,
      confirmationNumber: $('application-confirmation').value.trim(),
      nextAction: $('application-next-action').value.trim(),
      dueDate: $('application-due-date').value,
      notes: $('application-notes').value.trim()
    };
    if (application.status === 'submitted' && !application.confirmationNumber) { showError('application-error', 'Add the confirmation or receipt number from the portal before marking this submitted.'); return; }
    const generation = vaultGeneration;
    pending($('save-application'), async () => {
      setApplicationBusy(true);
      try {
        await api.saveApplication(application);
        if (await refreshApplications(generation)) { closeApplication(); toast('Application record saved locally.'); }
      } catch (error) { if (generation === vaultGeneration) showError('application-error', error); }
      finally { if (generation === vaultGeneration) setApplicationBusy(false); }
    });
  });
  $('delete-application').addEventListener('click', () => {
    if (!window.confirm('Delete this local application record? This does not withdraw an application from Iowa.')) return;
    const generation = vaultGeneration;
    const id = $('application-id').value;
    pending($('delete-application'), async () => {
      setApplicationBusy(true);
      try {
        await api.deleteApplication(id);
        if (await refreshApplications(generation)) { closeApplication(); toast('Local application record deleted.'); }
      } catch (error) { if (generation === vaultGeneration) showError('application-error', error); }
      finally { if (generation === vaultGeneration) setApplicationBusy(false); }
    });
  });

  $('prepare-extension').addEventListener('click', () => {
    clearError('extension-prepare-error');
    const generation = vaultGeneration;
    pending($('prepare-extension'), async () => {
      try {
        const result = await api.prepareExtension();
        if (!vaultStatus.unlocked || generation !== vaultGeneration) return;
        vaultStatus.extensionId = result.extensionId;
        vaultStatus.extensionSetup = result;
        renderSetup();
        toast(result.folderOpened ? 'Extension prepared. Now load the folder in Chrome using step 2.' : 'Extension prepared. Copy the folder path below to load it in Chrome.');
      } catch (error) { if (generation === vaultGeneration) showError('extension-prepare-error', error); }
    });
  });
  for (const [buttonId, method, message] of [
    ['copy-extension-path', 'copyExtensionFolderPath', 'Folder path copied. Paste it into Chrome’s folder chooser.'],
    ['open-extension-folder', 'openExtensionFolder', ''],
    ['copy-chrome-url', 'copyChromeExtensionsUrl', 'Chrome setup address copied. Paste it into Chrome’s address bar.']
  ]) {
    $(buttonId).addEventListener('click', () => {
      const generation = vaultGeneration;
      pending($(buttonId), async () => {
        try { await api[method](); if (message && generation === vaultGeneration) toast(message); }
        catch (error) { if (generation === vaultGeneration) showError('extension-prepare-error', error); }
      });
    });
  }

  $('extension-form').addEventListener('submit', (event) => {
    event.preventDefault(); clearError('extension-error');
    const extensionId = $('extension-id').value.trim();
    if (!/^[a-p]{32}$/.test(extensionId)) { showError('extension-error', 'Use the 32-letter ID shown for SecondHand in Chrome’s extensions page.'); return; }
    const generation = vaultGeneration;
    pending($('connect-extension'), async () => {
      try {
        const result = await api.connectExtension(extensionId);
        if (!vaultStatus.unlocked || generation !== vaultGeneration) return;
        vaultStatus.extensionId = result.extensionId; renderSetup(); toast('Extension registered. Keep SecondHand open while you use it.');
      } catch (error) { if (generation === vaultGeneration) showError('extension-error', error); }
    });
  });
  $('autofill-trust').addEventListener('change', () => {
    clearError('autofill-trust-error');
    const generation = vaultGeneration;
    const wanted = $('autofill-trust').checked;
    $('autofill-trust').disabled = true;
    api.setAutofillTrust(wanted).then(status => {
      if (generation !== vaultGeneration) return;
      vaultStatus = { ...vaultStatus, ...status };
      renderSetup();
      toast(wanted ? 'Chrome can now autofill without asking while SecondHand is unlocked.' : 'Chrome will ask before each autofill.');
    }, error => {
      if (generation !== vaultGeneration) return;
      $('autofill-trust').checked = !wanted;
      showError('autofill-trust-error', error);
    }).finally(() => { $('autofill-trust').disabled = false; });
  });
  $('all-sites-off').addEventListener('click', () => {
    clearError('autofill-trust-error');
    const generation = vaultGeneration;
    pending($('all-sites-off'), async () => {
      try {
        const status = await api.turnOffAllSites();
        if (generation !== vaultGeneration) return;
        vaultStatus = { ...vaultStatus, ...status }; renderAllSites();
        toast('SecondHand will no longer fill forms on every website. Sites you trusted one by one stay on.');
      } catch (error) { if (generation === vaultGeneration) showError('autofill-trust-error', error); }
    });
  });
  $('laya-toggle').addEventListener('change', () => {
    clearError('laya-error');
    const generation = vaultGeneration;
    const wanted = $('laya-toggle').checked;
    $('laya-toggle').disabled = true;
    api.setLayaEnabled(wanted).then(laya => {
      if (generation !== vaultGeneration) return;
      showLaya(laya);
      toast(wanted ? 'Laya is on. It runs only on this computer.' : 'Laya is off.');
    }, error => {
      if (generation !== vaultGeneration) return;
      $('laya-toggle').checked = !wanted;
      showError('laya-error', error);
    }).finally(() => { if (generation === vaultGeneration && vaultStatus.laya?.state !== 'unavailable') $('laya-toggle').disabled = false; });
  });
  for (const [buttonId, method, question, message] of [
    ['laya-download', 'downloadLaya', '', ''],
    ['laya-cancel', 'cancelLayaDownload', '', ''],
    ['laya-remove', 'removeLaya', 'Remove the Laya model from this computer and turn Laya off? Turn it on again to download the model.', 'The Laya model was removed from this computer, and Laya is off.']
  ]) {
    $(buttonId).addEventListener('click', () => {
      if (question && !window.confirm(question)) return;
      clearError('laya-error');
      const generation = vaultGeneration;
      pending($(buttonId), async () => {
        try {
          const laya = await api[method]();
          if (generation !== vaultGeneration) return;
          showLaya(laya);
          if (message) toast(message);
        } catch (error) { if (generation === vaultGeneration) showError('laya-error', error); }
      });
    });
  }
  $('extension-guide').addEventListener('click', () => pending($('extension-guide'), async () => {
    try { await api.openExtensionGuide(); } catch (error) { toast(error.message || 'Unable to open the guide.', true); }
  }));
  $('extension-open-portal').addEventListener('click', () => pending($('extension-open-portal'), async () => {
    try { await api.openPortal(); } catch (error) { toast(error.message || 'Unable to open the Iowa portal.', true); }
  }));
  $('export-backup').addEventListener('click', () => pending($('export-backup'), async () => {
    try { const result = await api.exportBackup(); if (!result.cancelled) toast('Encrypted backup saved. You’ll need your password to restore it.'); }
    catch (error) { toast(error.message || 'Unable to export your backup.', true); }
  }));

  window.addEventListener('focus', async () => {
    if (!api || !vaultStatus.unlocked) return;
    const generation = vaultGeneration;
    try {
      const status = await api.status();
      if (generation !== vaultGeneration) return;
      if (!status.unlocked) { showLocked(status); return; }
      vaultStatus = status;
      if (currentView === 'overview' || currentView === 'applications') await refreshApplications(generation);
    } catch { /* Keep the visible state until a user action or lock event provides a result. */ }
  });

  async function initialize() {
    if (!api) {
      showLocked();
      $('preview-notice').hidden = false;
      $('auth-submit').disabled = true;
      $('auth-import').disabled = true;
      $('passphrase').disabled = true;
      $('confirm-passphrase').disabled = true;
      return;
    }
    // The lock response and this notification can arrive in either order. The lock
    // revision lets showLocked skip a repeat of a lock already shown, so a late notice
    // cannot reset an unlock attempt the person has started, while a newer lock still
    // cancels any pending unlock or profile load.
    api.onLocked(notification => {
      showLocked({ ...vaultStatus, exists: true, unlocked: false, lockRevision: notification?.lockRevision });
      refreshTouchIdUnlock();
    });
    api.onProfileChanged(change => profileChangedElsewhere(change.fields));
    // Unlocked from Chrome's side panel with Touch ID: show the saved information here too.
    api.onUnlocked(async () => {
      if (vaultStatus.unlocked) return;
      const generation = vaultGeneration;
      try {
        const status = await api.status();
        if (generation !== vaultGeneration || vaultStatus.unlocked || !status.unlocked) return;
        await loadUnlocked(status);
      } catch (error) { if (generation === vaultGeneration) showError('auth-error', error); }
    });
    try {
      const status = await api.status();
      if (status.unlocked) await loadUnlocked(status); else showLocked(status);
    } catch (error) { showLocked(); showError('auth-error', error); }
  }
  initialize();
})();

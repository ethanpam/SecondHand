'use strict';

(() => {
  const api = window.secondHand;
  const $ = (id) => document.getElementById(id);
  const profileFields = ['firstName', 'middleName', 'lastName', 'suffix', 'maidenName', 'isApplicant',
    'birthDate', 'ssn', 'email', 'phone', 'homePhone', 'mobilePhone', 'bestContactTime',
    'hasHomeAddress', 'mailingSameAsHome', 'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county',
    'mailingAddressLine1', 'mailingAddressLine2', 'mailingCity', 'mailingState', 'mailingZip',
    'programSnap', 'programFip', 'programMedicaid', 'helpPayMedicalBills', 'householdSize',
    'monthlyEarnedIncome', 'monthlyOtherIncome', 'monthlyRent', 'monthlyUtilities'];
  const viewNames = { overview: 'Overview', profile: 'My information', applications: 'Applications', extension: 'Chrome extension', privacy: 'Privacy & backups' };
  const statusNames = { draft: 'Draft', in_progress: 'In progress', submitted: 'Submitted', needs_action: 'Needs action', approved: 'Approved', denied: 'Denied' };
  let vaultStatus = { exists: false, unlocked: false, extensionId: '', bridgeRunning: false };
  let data = { profile: {}, applications: [] };
  let currentView = 'overview';
  let profileDirty = false;
  let profileRevision = 0;
  let applicationBusy = false;
  let toastTimer;
  let vaultGeneration = 0;

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
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
    try { return await action(); }
    finally {
      if (generation === vaultGeneration) {
        button.disabled = !api;
        button.removeAttribute('aria-busy');
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
    $('profile-save-state').textContent = value ? 'Unsaved changes' : 'Saved locally';
    $('profile-save-state').classList.toggle('unsaved', value);
    $('profile-nav-dot').hidden = !value;
  }

  function clearSensitiveUI() {
    vaultGeneration++;
    document.querySelectorAll('button[aria-busy="true"]').forEach((button) => {
      button.disabled = !api;
      button.removeAttribute('aria-busy');
    });
    setApplicationBusy(false);
    data = { profile: {}, applications: [] };
    $('profile-form').reset();
    $('application-form').reset();
    $('application-id').value = '';
    $('auth-form').reset();
    $('application-list').replaceChildren();
    $('overview-applications').replaceChildren();
    $('overview-heading').textContent = 'Let’s move forward.';
    $('application-count').textContent = '0';
    if ($('application-dialog').open) $('application-dialog').close();
    for (const id of ['auth-error', 'profile-error', 'application-error', 'extension-error', 'extension-prepare-error']) clearError(id);
    setProfileDirty(false);
    clearTimeout(toastTimer);
    $('toast').hidden = true;
    $('toast').textContent = '';
  }

  function showLocked(status = vaultStatus) {
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
    $('recovery-note').textContent = exists ? 'Your password never leaves this computer.' : 'Keep your password somewhere safe. There is no online account, so no one can reset it for you.';
    if (api) $('passphrase').focus();
  }

  function showView(view, { skipConfirmation = false, focus = true } = {}) {
    if (!viewNames[view] || !vaultStatus.unlocked) return;
    if (!skipConfirmation && currentView === 'profile' && view !== 'profile' && profileDirty) {
      if (!window.confirm('Leave without saving your profile changes?')) return;
      fillProfile();
    }
    currentView = view;
    for (const key of Object.keys(viewNames)) $(`view-${key}`).hidden = key !== view;
    document.querySelectorAll('.nav-item').forEach((item) => {
      const selected = item.dataset.view === view;
      item.classList.toggle('active', selected);
      if (selected) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
    $('breadcrumb-current').textContent = viewNames[view];
    if (focus) { $('main-content').focus(); window.scrollTo(0, 0); }
  }

  function fillProfile() {
    profileRevision++;
    for (const key of profileFields) $(key).value = typeof data.profile[key] === 'string' ? data.profile[key] : '';
    setProfileDirty(false);
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
      empty.append(emptyIcon, element('h2', '', 'Your next chapter starts here.'), element('p', '', 'Add an Iowa SNAP application record to keep track of progress, agency requests, and your next step.'), add);
      list.append(empty);
      const compact = element('div', 'overview-empty');
      const copy = element('div');
      copy.append(element('h3', '', 'A fresh start. Nothing to track just yet.'), element('p', '', 'When you add an application, you’ll see it here.'));
      compact.append(icon('file'), copy); overview.append(compact);
      return;
    }
    for (const application of sortedApplications()) {
      const card = element('article', 'application-card');
      const header = element('div', 'application-card-header');
      const title = element('div', 'application-card-title');
      const mark = element('span', 'card-icon'); mark.append(icon('file'));
      const titleText = element('div');
      titleText.append(element('h3', '', 'Iowa SNAP'), element('p', 'application-meta', `Started ${dateLabel(application.createdAt) || '—'}`));
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
      footer.append(element('p', '', 'Personal record · Update from your agency notices'), edit); card.append(footer); list.append(card);
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

  function renderSummary() {
    const hasProfile = profileFields.some((field) => Boolean(data.profile[field]));
    $('profile-step-label').replaceChildren(document.createTextNode(hasProfile ? 'Review my profile ' : 'Set up my profile '), icon('arrow'));
    renderApplications(); renderSetup();
  }

  async function loadUnlocked(status) {
    const generation = vaultGeneration;
    const loaded = await api.getData();
    if (generation !== vaultGeneration) return;
    vaultStatus = status;
    data = { profile: loaded.profile || {}, applications: Array.isArray(loaded.applications) ? loaded.applications : [] };
    $('auth-form').reset();
    $('auth-view').hidden = true;
    $('workspace').hidden = false;
    fillProfile(); renderSummary();
    showView('overview', { skipConfirmation: true });
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
    const latest = await api.getData();
    if (!vaultStatus.unlocked || generation !== vaultGeneration) return false;
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
    pending($('auth-submit'), async () => {
      try {
        const status = vaultStatus.exists ? await api.unlock($('passphrase').value) : await api.createVault($('passphrase').value);
        await loadUnlocked(status);
      } catch (error) { showError('auth-error', error); }
      finally { $('passphrase').value = ''; $('confirm-passphrase').value = ''; }
    });
  });

  $('auth-import').addEventListener('click', () => {
    if (!api) return;
    if (vaultStatus.exists && !window.confirm('Restoring replaces the information saved on this computer. Make sure you have a backup of anything you want to keep. Continue?')) return;
    pending($('auth-import'), async () => {
      try {
        const result = await api.importBackup();
        if (result.cancelled) return;
        showLocked(await api.status());
        toast('Backup restored. Unlock it with the password it was created with.');
      } catch (error) { showError('auth-error', error); }
    });
  });

  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); showView(button.dataset.view); }));
  document.querySelector('.auth-brand').addEventListener('click', (event) => event.preventDefault());
  $('overview-start').addEventListener('click', () => showView('profile'));
  $('lock-button').addEventListener('click', lockVault);
  $('privacy-lock').addEventListener('click', lockVault);
  $('profile-form').addEventListener('input', () => { profileRevision++; setProfileDirty(true); });
  $('profile-form').addEventListener('submit', (event) => {
    event.preventDefault(); clearError('profile-error');
    const generation = vaultGeneration;
    const revision = profileRevision;
    const profile = Object.fromEntries(profileFields.map((field) => [field, $(field).value.trim()]));
    pending($('save-profile'), async () => {
      try {
        const saved = await api.saveProfile(profile);
        if (!vaultStatus.unlocked || generation !== vaultGeneration) return;
        data.profile = saved;
        const newerEdits = profileDirty && profileRevision !== revision;
        if (!newerEdits) fillProfile();
        renderSummary();
        toast(newerEdits ? 'Earlier changes saved. Your newer edits still need to be saved.' : 'Your information is saved on this computer.');
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
    api.onLocked(() => showLocked({ ...vaultStatus, exists: true, unlocked: false }));
    try {
      const status = await api.status();
      if (status.unlocked) await loadUnlocked(status); else showLocked(status);
    } catch (error) { showLocked(); showError('auth-error', error); }
  }
  initialize();
})();

'use strict';

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { PROFILE_FIELDS, isPortalUrl } = require('../shared/schema.cjs');

const ASSISTANCE_DURATION_MS = 15 * 60 * 1000;
const ASSISTANCE_TOKEN = /^[0-9a-f]{64}$/;
const EXTENSION_ID = /^[a-p]{32}$/;

function validateFieldScope(fields) {
  if (!Array.isArray(fields) || !fields.length || fields.length > PROFILE_FIELDS.length ||
      fields.some(field => typeof field !== 'string' || !PROFILE_FIELDS.includes(field)) ||
      new Set(fields).size !== fields.length) throw new Error('Invalid requested profile fields.');
  return fields;
}

// Only authorization metadata is kept here. Profile values remain in the vault.
// Monotonic and wall-clock deadlines prevent clock changes from extending a grant.
class AssistedSession {
  constructor({ wallNow = Date.now, monotonicNow = () => performance.now() } = {}) {
    this.wallNow = wallNow;
    this.monotonicNow = monotonicNow;
    this.generation = 0;
    this.session = null;
  }

  revoke() {
    this.generation++;
    if (this.session) this.session.token.fill(0);
    this.session = null;
  }

  issue({ extensionId, url, fields }) {
    if (!EXTENSION_ID.test(extensionId || '') || !isPortalUrl(url)) throw new Error('Invalid assisted session destination.');
    validateFieldScope(fields);
    this.revoke();
    const token = crypto.randomBytes(32);
    const expiresAt = this.wallNow() + ASSISTANCE_DURATION_MS;
    this.session = { token, extensionId, fields: new Set(fields), expiresAt,
      deadline: this.monotonicNow() + ASSISTANCE_DURATION_MS };
    return { assistanceToken: token.toString('hex'), expiresAt: new Date(expiresAt).toISOString(), fields: [...fields] };
  }

  matches(token, extensionId) {
    return Boolean(this.session && typeof token === 'string' && ASSISTANCE_TOKEN.test(token) &&
      extensionId === this.session.extensionId &&
      crypto.timingSafeEqual(Buffer.from(token, 'hex'), this.session.token));
  }

  check({ assistanceToken, extensionId, url }) {
    if (this.session && (this.wallNow() >= this.session.expiresAt || this.monotonicNow() >= this.session.deadline)) this.revoke();
    if (!this.matches(assistanceToken, extensionId)) throw new Error('Guided assistance has ended. Start it again from the extension.');
    if (!isPortalUrl(url)) throw new Error('Only the supported Iowa portal is allowed.');
    return { active: true };
  }

  authorize({ assistanceToken, extensionId, url, fields }) {
    this.check({ assistanceToken, extensionId, url });
    validateFieldScope(fields);
    if (fields.some(field => !this.session.fields.has(field))) throw new Error('These fields were not approved for this guided session.');
  }

  end({ assistanceToken, extensionId }) {
    // An old worker's delayed Stop message must not revoke a newer session.
    if (this.matches(assistanceToken, extensionId)) this.revoke();
    return { ended: true };
  }
}

module.exports = { AssistedSession, ASSISTANCE_DURATION_MS, ASSISTANCE_TOKEN, validateFieldScope };

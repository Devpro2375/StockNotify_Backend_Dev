// services/firebase.js
// Single source of truth for Firebase Admin initialization.

const admin = require('firebase-admin');
const config = require('../config/config');

function parseServiceAccount(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT JSON.');
    }
  }
  return null;
}

if (admin.apps.length === 0) {
  const sa =
    parseServiceAccount(config.firebaseServiceAccount) ||
    parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);

  if (!sa) {
    console.error(
      'Firebase service account not provided. Set FIREBASE_SERVICE_ACCOUNT in environment.'
    );
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(sa),
  });

  console.log('✅ Firebase Admin initialized successfully.');
} else {
  console.log('✅ Firebase Admin already initialized.');
}

module.exports = admin;

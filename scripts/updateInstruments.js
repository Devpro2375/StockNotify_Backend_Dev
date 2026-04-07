// scripts/updateInstruments.js
// Run once to populate MongoDB with fresh NSE+BSE EQ+INDEX instruments
// Usage: node scripts/updateInstruments.js

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config/config');
const { updateInstruments } = require('../services/instrumentService');

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(config.mongoURI);
    console.log('MongoDB connected');

    const result = await updateInstruments();
    console.log(`Done. Inserted: ${result.count}, Deleted: ${result.deleted}`);
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

run();

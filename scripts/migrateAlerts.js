// scripts/migrateAlerts.js

const mongoose = require("mongoose");
const config = require("../config/config");
const { migrateAlerts } = require("../services/socketService");

async function runMigration() {
  try {
    // Connect to MongoDB
    await mongoose.connect(config.mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");

    // Run migration
    await migrateAlerts();

    console.log("✅ Migration completed successfully");
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

runMigration();

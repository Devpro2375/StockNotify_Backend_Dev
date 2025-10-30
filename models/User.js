const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: false }, // Not required for Google users
  googleId: { type: String, unique: true, sparse: true },
  isVerified: { type: Boolean, default: false },
  verificationToken: { type: String },
  verificationTokenExpires: { type: Date },
  deviceToken: { type: String },
  refreshToken: { type: String }, // For persistent sessions

  // Notification preferences
  emailAlerts: { type: Boolean, default: true },
  pushAlerts: { type: Boolean, default: true },
  smsAlerts: { type: Boolean, default: false },

  // Telegram fields (existing)
  telegramChatId: { type: String, default: null, index: true },
  telegramUsername: { type: String, default: null },
  telegramEnabled: { type: Boolean, default: false },
  telegramLinkedAt: { type: Date, default: null },
}, {
  timestamps: true
});

// Indexes (existing)
userSchema.index({ email: 1 });
userSchema.index({ username: 1 });
userSchema.index({ verificationToken: 1 });

// Pre-save hook for password hashing (existing)
userSchema.pre('save', async function(next) {
  if (this.isModified('password') && this.password) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});

// Compare password method (existing)
userSchema.methods.comparePassword = async function(password) {
  return bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', userSchema);

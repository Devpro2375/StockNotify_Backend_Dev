const mongoose = require('mongoose');

const accessTokenSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true
  },
  user_id: String,
  user_name: String,
  email: String,
  broker: String,
  updated_at: {
    type: Date,
    default: Date.now
  },
  expires_at: Date,
  metadata: {
    products: [String],
    exchanges: [String],
    is_active: Boolean
  }
}, { timestamps: true });

module.exports = mongoose.model('AccessToken', accessTokenSchema);

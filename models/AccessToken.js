const mongoose = require('mongoose');

const accessTokenSchema = new mongoose.Schema({
  token: {
    type: String,
  
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});



module.exports = mongoose.model('AccessToken', accessTokenSchema);
 
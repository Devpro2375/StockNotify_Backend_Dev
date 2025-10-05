const jwt = require('jsonwebtoken');
const config = require('../config/config');

module.exports = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded.user;
    next();
  } catch (err) {
    
    // Token expired or invalid
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ msg: 'Token expired', expired: true });
    }
    res.status(401).json({ msg: 'Token is not valid' });
  }
};

/**
 * Wraps async Express route handlers to properly catch errors
 * and forward them to Express error handling middleware.
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;

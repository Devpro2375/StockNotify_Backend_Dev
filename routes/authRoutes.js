const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { check } = require('express-validator');
const passport = require('passport');
const authMiddleware = require('../middlewares/authMiddleware');

// Email/Password Register
router.post('/register', [
  check('username', 'Username is required').not().isEmpty(),
  check('email', 'Please include a valid email').isEmail(),
  check('password', 'Password must be 6+ characters').isLength({ min: 6 })
], authController.register);

// Email/Password Login (with remember me)
router.post('/login', [
  check('email', 'Please include a valid email').isEmail(),
  check('password', 'Password is required').exists()
], authController.login);

// Email Verification
router.post('/resend-verification', authController.resendVerification);
router.get('/verify/:token', authController.verifyEmail);

// Protected routes
router.get('/me', authMiddleware, authController.getMe);
router.post('/update-token', authMiddleware, authController.updateDeviceToken);
router.post('/logout', authMiddleware, authController.logout);

// Google OAuth
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login' }),
  authController.googleCallback
);

module.exports = router;

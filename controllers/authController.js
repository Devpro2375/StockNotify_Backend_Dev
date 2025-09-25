// controllers/authController.js

const User = require("../models/User");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const crypto = require('crypto');
const { sendVerificationEmail } = require('../utils/email');
const { validationResult } = require('express-validator');

exports.register = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { username, email, password } = req.body;
  try {
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ msg: "User already exists" });

    user = await User.findOne({ username });
    if (user) return res.status(400).json({ msg: "Username already taken" });

    user = new User({ username, email, password });

    // Generate verification token
    user.verificationToken = crypto.randomBytes(32).toString('hex');
    user.verificationTokenExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    // Send verification email
    const verifyUrl = `${config.frontendBaseUrl}/verify-email?token=${user.verificationToken}`;
    await sendVerificationEmail(user.email, verifyUrl);

    res.json({ msg: "Registration successful. Please check your email to verify." });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};

exports.login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "Invalid credentials" });

    // Skip verification for Google users
    if (!user.googleId && !user.isVerified) {
      return res.status(400).json({ msg: "Email not verified. Please verify your email or use Google login." });
    }

    if (!user.password) {
      return res.status(400).json({ msg: "This account uses Google login. Please sign in with Google." });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    const payload = { user: { id: user.id } };
    const token = jwt.sign(payload, config.jwtSecret, { expiresIn: "24h" });

    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};

exports.verifyEmail = async (req, res) => {
  const { token } = req.params;
  console.log('Verification attempt with token:', token); // Log the incoming token

  try {
    // Attempt to find user with matching token that is not expired
    const user = await User.findOne({
      verificationToken: token,
      verificationTokenExpires: { $gt: Date.now() }
    });

    if (!user) {
      // Additional check: See if token exists but is expired or already used
      const existingUser = await User.findOne({ verificationToken: token });
      if (existingUser) {
        console.log('Token found but expired for user:', existingUser.email);
        return res.status(400).json({ msg: "Token has expired. Please request a new verification email." });
      } else if (existingUser && existingUser.isVerified) {
        console.log('User already verified:', existingUser.email);
        return res.json({ msg: "Email already verified. You can log in now." });
      }
      console.log('No matching user found for token:', token);
      return res.status(400).json({ msg: "Invalid token. Please register again." });
    }

    console.log('Valid token for user:', user.email);

    // If already verified (edge case), return early
    if (user.isVerified) {
      console.log('User already verified:', user.email);
      return res.json({ msg: "Email already verified. You can log in now." });
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save();

    const payload = { user: { id: user.id } };
    const jwtToken = jwt.sign(payload, config.jwtSecret, { expiresIn: "24h" });

    res.json({ msg: "Email verified successfully", token: jwtToken });
  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).send("Server error");
  }
};

exports.resendVerification = async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "User not found" });
    if (user.isVerified) return res.status(400).json({ msg: "Email already verified" });
    if (user.googleId) return res.status(400).json({ msg: "This account uses Google login and is already verified" });

    // Generate new token
    user.verificationToken = crypto.randomBytes(32).toString('hex');
    user.verificationTokenExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    const verifyUrl = `${config.frontendBaseUrl}/verify-email?token=${user.verificationToken}`;
    await sendVerificationEmail(user.email, verifyUrl);

    res.json({ msg: "Verification email resent. Please check your inbox." });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};

exports.getMe = async (req, res) => {
  try {
    // req.user is set by authMiddleware
    const user = await User.findById(req.user.id).select('-password -googleId -verificationToken -verificationTokenExpires');
    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }
    res.json({ user });
  } catch (err) {
    console.error('Error in /me:', err);
    res.status(500).send("Server error");
  }
};

// For Google OAuth success (called by Passport)
exports.googleCallback = (req, res) => {
  const payload = { user: { id: req.user.id } };
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: "24h" });
  // Redirect to frontend with token (adjust URL as needed)
  res.redirect(`${config.frontendBaseUrl}/auth/callback?token=${token}`);
};

// New: Update device token for push notifications
exports.updateDeviceToken = async (req, res) => {
  const { deviceToken } = req.body;
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ msg: "User not found" });

    user.deviceToken = deviceToken;
    await user.save();

    res.json({ msg: "Device token updated successfully" });
  } catch (err) {
    console.error("Error updating device token:", err);
    res.status(500).send("Server error");
  }
};

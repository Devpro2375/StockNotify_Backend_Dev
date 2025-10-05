const User = require("../models/User");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const crypto = require('crypto');
const { sendVerificationEmail } = require('../utils/email');
const { validationResult } = require('express-validator');

// User cache for /me endpoint
const userCache = new Map();
const CACHE_TTL = 300000; // 5 minutes

// Generate JWT with flexible expiry
const generateToken = (userId, rememberMe = false) => {
  const payload = { user: { id: userId } };
  const expiresIn = rememberMe ? "30d" : "1d";
  return jwt.sign(payload, config.jwtSecret, { expiresIn });
};

// Clear user from cache
const clearUserCache = (userId) => {
  userCache.delete(userId);
};

exports.register = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { username, email, password } = req.body;
  try {
    // Check both email and username in one query
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(400).json({ msg: "User already exists" });
      }
      return res.status(400).json({ msg: "Username already taken" });
    }

    const user = new User({ username, email, password });
    user.verificationToken = crypto.randomBytes(32).toString('hex');
    user.verificationTokenExpires = Date.now() + 3600000;
    await user.save();

    const verifyUrl = `${config.frontendBaseUrl}/verify-email?token=${user.verificationToken}`;
    
    // Don't wait for email - send async
    sendVerificationEmail(user.email, verifyUrl).catch(err => 
      console.error("Email send error:", err)
    );

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

  const { email, password, rememberMe } = req.body;
  try {
    const user = await User.findOne({ email }).select('+password');
    if (!user) return res.status(400).json({ msg: "Invalid credentials" });

    if (!user.googleId && !user.isVerified) {
      return res.status(400).json({ 
        msg: "Email not verified. Please verify your email or use Google login." 
      });
    }

    if (!user.password) {
      return res.status(400).json({ 
        msg: "This account uses Google login. Please sign in with Google." 
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    // Generate token based on remember me
    const token = generateToken(user.id, rememberMe);

    // Cache user data
    userCache.set(user.id, {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isVerified: user.isVerified
      },
      expiresAt: Date.now() + CACHE_TTL
    });

    res.json({ 
      token,
      expiresIn: rememberMe ? "30d" : "1d",
      user: { 
        id: user.id, 
        username: user.username, 
        email: user.email,
        isVerified: user.isVerified 
      } 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};

exports.verifyEmail = async (req, res) => {
  const { token } = req.params;

  try {
    const user = await User.findOne({
      verificationToken: token,
      verificationTokenExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ msg: "Invalid or expired token" });
    }

    if (user.isVerified) {
      return res.json({ msg: "Email already verified. You can log in now." });
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save();

    // Default to 7 days for email verification
    const jwtToken = generateToken(user.id, true);

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
    if (user.googleId) return res.status(400).json({ 
      msg: "This account uses Google login and is already verified" 
    });

    user.verificationToken = crypto.randomBytes(32).toString('hex');
    user.verificationTokenExpires = Date.now() + 3600000;
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
    const userId = req.user.id;

    // Check cache first
    const cached = userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ user: cached.user });
    }

    // Cache miss - fetch from DB
    const user = await User.findById(userId)
      .select('-password -googleId -verificationToken -verificationTokenExpires')
      .lean();
    
    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    // Cache the result
    userCache.set(userId, {
      user,
      expiresAt: Date.now() + CACHE_TTL
    });

    res.json({ user });
  } catch (err) {
    console.error('Error in /me:', err);
    res.status(500).send("Server error");
  }
};

exports.googleCallback = (req, res) => {
  const token = generateToken(req.user.id, true); // 30 days for Google login
  res.redirect(`${config.frontendBaseUrl}/auth/callback?token=${token}`);
};

exports.updateDeviceToken = async (req, res) => {
  const { deviceToken } = req.body;
  try {
    await User.findByIdAndUpdate(req.user.id, { deviceToken });
    res.json({ msg: "Device token updated successfully" });
  } catch (err) {
    console.error("Error updating device token:", err);
    res.status(500).send("Server error");
  }
};

exports.logout = async (req, res) => {
  try {
    clearUserCache(req.user.id);
    res.json({ msg: "Logged out successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};

// Cleanup cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of userCache.entries()) {
    if (data.expiresAt < now) {
      userCache.delete(userId);
    }
  }
}, 300000);

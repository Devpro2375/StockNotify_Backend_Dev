// controllers/authController.js
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const crypto = require('crypto');
const { sendVerificationEmail } = require('../utils/email');
const { validationResult } = require('express-validator');

// OPTIMIZATION: User cache for /me endpoint
const userCache = new Map();
const USER_CACHE_TTL = 300000; // 5 minutes

// Generate JWT access token
const generateAccessToken = (userId) => {
  const payload = { user: { id: userId } };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "15m" });
};

// Generate refresh token
const generateRefreshToken = () => {
  return crypto.randomBytes(40).toString('hex');
};

// OPTIMIZATION: Clear user from cache
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
    // OPTIMIZATION: Check both email and username in one query
    const existingUser = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(400).json({ msg: "User already exists" });
      }
      return res.status(400).json({ msg: "Username already taken" });
    }

    const user = new User({ username, email, password });

    // Generate verification token
    user.verificationToken = crypto.randomBytes(32).toString('hex');
    user.verificationTokenExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    // Send verification email (async, don't wait)
    const verifyUrl = `${config.frontendBaseUrl}/verify-email?token=${user.verificationToken}`;
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

  const { email, password } = req.body;
  try {
    // OPTIMIZATION: Select only needed fields
    const user = await User.findOne({ email }).select('+password');
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

    // Generate tokens
    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken();

    // OPTIMIZATION: Update user without fetching again
    user.refreshToken = refreshToken;
    await user.save();

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/'
    });

    // Cache user data
    userCache.set(user.id, {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isVerified: user.isVerified
      },
      expiresAt: Date.now() + USER_CACHE_TTL
    });

    res.json({ 
      token: accessToken, 
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

    // Update user
    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;

    // Generate tokens
    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken();
    user.refreshToken = refreshToken;
    
    await user.save();

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });

    res.json({ msg: "Email verified successfully", token: accessToken });
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

// CRITICAL OPTIMIZATION: Cache user data for /me endpoint
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
      .select('-password -googleId -verificationToken -verificationTokenExpires -refreshToken')
      .lean(); // Use lean() for faster queries
    
    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    // Cache the result
    userCache.set(userId, {
      user,
      expiresAt: Date.now() + USER_CACHE_TTL
    });

    res.json({ user });
  } catch (err) {
    console.error('Error in /me:', err);
    res.status(500).send("Server error");
  }
};

// CRITICAL OPTIMIZATION: Fast refresh token lookup
exports.refreshToken = async (req, res) => {
  const { refreshToken } = req.cookies;

  if (!refreshToken) {
    return res.status(401).json({ msg: "No refresh token provided" });
  }

  try {
    // OPTIMIZATION: Only select _id for faster query
    const user = await User.findOne({ refreshToken }).select('_id').lean();
    
    if (!user) {
      return res.status(403).json({ msg: "Invalid refresh token" });
    }

    // Generate new access token
    const newAccessToken = generateAccessToken(user._id);

    // OPTIMIZATION: Optionally rotate refresh token for security
    // const newRefreshToken = generateRefreshToken();
    // await User.findByIdAndUpdate(user._id, { refreshToken: newRefreshToken });
    // res.cookie('refreshToken', newRefreshToken, { ... });

    res.json({ token: newAccessToken });
  } catch (err) {
    console.error("Refresh token error:", err);
    res.status(500).send("Server error");
  }
};

// Logout
exports.logout = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Clear cache
    clearUserCache(userId);
    
    // Clear refresh token from database
    await User.findByIdAndUpdate(userId, { refreshToken: null });
    
    // Clear cookie
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/'
    });
    
    res.json({ msg: "Logged out successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};

// Google OAuth callback
exports.googleCallback = async (req, res) => {
  try {
    const accessToken = generateAccessToken(req.user.id);
    const refreshToken = generateRefreshToken();

    // Save refresh token
    await User.findByIdAndUpdate(req.user.id, { refreshToken });

    // Set refresh token cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });

    // Redirect to frontend with access token
    res.redirect(`${config.frontendBaseUrl}/auth/callback?token=${accessToken}`);
  } catch (err) {
    console.error("Google callback error:", err);
    res.redirect(`${config.frontendBaseUrl}/login?error=auth_failed`);
  }
};

// Update device token
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

// Cleanup cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of userCache.entries()) {
    if (data.expiresAt < now) {
      userCache.delete(userId);
    }
  }
}, 300000); // Clean every 5 minutes

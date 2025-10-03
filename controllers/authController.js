const User = require("../models/User");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const crypto = require('crypto');
const { sendVerificationEmail } = require('../utils/email');
const { validationResult } = require('express-validator');

// Generate JWT access token
const generateAccessToken = (userId) => {
  const payload = { user: { id: userId } };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "15m" });
};

// Generate refresh token
const generateRefreshToken = () => {
  return crypto.randomBytes(40).toString('hex');
};

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

    // Generate tokens
    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken();

    // Save refresh token to database
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
  console.log('Verification attempt with token:', token);

  try {
    const user = await User.findOne({
      verificationToken: token,
      verificationTokenExpires: { $gt: Date.now() }
    });

    if (!user) {
      const existingUser = await User.findOne({ verificationToken: token });
      if (existingUser && existingUser.verificationTokenExpires < Date.now()) {
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

    if (user.isVerified) {
      console.log('User already verified:', user.email);
      return res.json({ msg: "Email already verified. You can log in now." });
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save();

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

exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password -googleId -verificationToken -verificationTokenExpires -refreshToken');
    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }
    res.json({ user });
  } catch (err) {
    console.error('Error in /me:', err);
    res.status(500).send("Server error");
  }
};

// Refresh access token
exports.refreshToken = async (req, res) => {
  const { refreshToken } = req.cookies;

  if (!refreshToken) {
    return res.status(401).json({ msg: "No refresh token provided" });
  }

  try {
    const user = await User.findOne({ refreshToken });
    
    if (!user) {
      return res.status(403).json({ msg: "Invalid refresh token" });
    }

    // Generate new access token
    const newAccessToken = generateAccessToken(user.id);

    res.json({ token: newAccessToken });
  } catch (err) {
    console.error("Refresh token error:", err);
    res.status(500).send("Server error");
  }
};

// Logout
exports.logout = async (req, res) => {
  try {
    // Clear refresh token from database
    await User.findByIdAndUpdate(req.user.id, { refreshToken: null });
    
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

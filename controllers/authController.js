const User = require("../models/User");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const crypto = require("crypto");
const { sendVerificationEmail } = require("../utils/email");
const { validationResult } = require("express-validator");


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


// ============================================
// UPDATED: Register with AWAIT email sending
// ============================================
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
    user.verificationToken = crypto.randomBytes(32).toString("hex");
    user.verificationTokenExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    const verifyUrl = `${config.frontendBaseUrl}/verify-email?token=${user.verificationToken}`;

    // ✅ CRITICAL FIX: Wait for email to send
    try {
      console.log(`📧 Attempting to send verification email to: ${email}`);
      await sendVerificationEmail(user.email, verifyUrl);
      console.log(`✅ Verification email sent successfully to ${user.email}`);
      
      res.json({
        msg: "Registration successful. Please check your email to verify.",
        success: true
      });
    } catch (emailError) {
      // Email failed but user is created - log detailed error
      console.error("❌ VERIFICATION EMAIL FAILED:");
      console.error("Message:", emailError.message);
      console.error("Code:", emailError.code);
      console.error("Command:", emailError.command);
      console.error("Response:", emailError.response);
      console.error("ResponseCode:", emailError.responseCode);
      
      // Still return success but with warning
      res.json({
        msg: "Registration successful. However, we're experiencing issues sending verification emails. Please try resending it from the login page.",
        success: true,
        emailWarning: true
      });
    }
  } catch (err) {
    console.error("❌ Registration error:", err);
    res.status(500).json({ 
      msg: "Server error",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};


exports.login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password, rememberMe } = req.body;
  try {
    const user = await User.findOne({ email }).select("+password");
    if (!user) return res.status(400).json({ msg: "Invalid credentials" });

    if (!user.googleId && !user.isVerified) {
      return res.status(400).json({
        msg: "Email not verified. Please verify your email or use Google login.",
      });
    }

    if (!user.password) {
      return res.status(400).json({
        msg: "This account uses Google login. Please sign in with Google.",
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
        isVerified: user.isVerified,
      },
      expiresAt: Date.now() + CACHE_TTL,
    });

    res.json({
      token,
      expiresIn: rememberMe ? "30d" : "1d",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isVerified: user.isVerified,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};


exports.verifyEmail = async (req, res) => {
  const { token } = req.params;

  // Validate token parameter
  if (!token) {
    console.log('❌ Verification failed: No token provided');
    return res.status(400).json({ msg: "Verification token is required" });
  }

  try {
    console.log(`🔍 Searching for user with token: ${token.substring(0, 10)}...`);
    
    const user = await User.findOne({
      verificationToken: token,
      verificationTokenExpires: { $gt: Date.now() }
    });

    if (!user) {
      console.log('❌ Invalid or expired token');
      return res.status(400).json({ 
        msg: "Invalid or expired verification token. Please request a new verification email.",
        expired: true
      });
    }

    if (user.isVerified) {
      console.log(`⚠️ Email already verified for user: ${user.email}`);
      return res.json({ 
        msg: "Email already verified. You can log in now.",
        alreadyVerified: true,
        user: {
          email: user.email,
          username: user.username
        }
      });
    }

    // Mark as verified
    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save();

    console.log(`✅ Email verified successfully for: ${user.email}`);

    // Generate JWT token with 7-day expiry
    const jwtToken = generateToken(user.id, true);

    res.json({ 
      msg: "Email verified successfully! You can now log in.",
      success: true,
      token: jwtToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        isVerified: true
      }
    });
  } catch (err) {
    console.error('❌ Email verification error:', err);
    console.error('Stack:', err.stack);
    res.status(500).json({ 
      msg: "Server error during verification",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};


// =================================================
// UPDATED: Resend Verification with AWAIT
// =================================================
exports.resendVerification = async (req, res) => {
  const { email } = req.body;

  // Validate input
  if (!email || !email.trim()) {
    console.log("❌ Resend verification: No email provided");
    return res.status(400).json({ msg: "Email is required" });
  }

  try {
    console.log(`🔍 Looking up user: ${email}`);
    const user = await User.findOne({ email: email.trim().toLowerCase() });

    if (!user) {
      console.log(`❌ User not found: ${email}`);
      return res.status(404).json({ msg: "User not found" });
    }

    if (user.isVerified) {
      console.log(`⚠️ Email already verified: ${email}`);
      return res.status(400).json({ msg: "Email already verified" });
    }

    if (user.googleId) {
      console.log(`⚠️ Google account detected: ${email}`);
      return res.status(400).json({
        msg: "This account uses Google login and is already verified",
      });
    }

    // Generate new token
    user.verificationToken = crypto.randomBytes(32).toString("hex");
    user.verificationTokenExpires = Date.now() + 3600000; // 1 hour
    await user.save();
    console.log(`✅ New token generated for: ${email}`);

    const verifyUrl = `${config.frontendBaseUrl}/verify-email?token=${user.verificationToken}`;
    console.log(`🔗 Verify URL: ${verifyUrl.substring(0, 50)}...`);

    // ✅ Send email with proper error handling
    try {
      console.log(`📨 Attempting to send email to: ${email}`);
      await sendVerificationEmail(user.email, verifyUrl);
      console.log(`✅ Verification email sent successfully to: ${email}`);

      return res.json({
        msg: "Verification email resent. Please check your inbox.",
        success: true,
      });
    } catch (emailError) {
      // Detailed error logging
      console.error("❌ EMAIL SENDING ERROR:");
      console.error("Message:", emailError.message);
      console.error("Code:", emailError.code);
      console.error("Command:", emailError.command);
      console.error("Response:", emailError.response);
      console.error("ResponseCode:", emailError.responseCode);
      console.error("Stack:", emailError.stack);

      // Check for specific error types
      if (emailError.code === "EAUTH") {
        return res.status(500).json({
          msg: "Email authentication failed. Please contact support.",
          error: process.env.NODE_ENV === "development" 
            ? "Gmail App Password authentication error" 
            : undefined,
        });
      }

      if (emailError.code === "ESOCKET" || emailError.code === "ETIMEDOUT" || emailError.code === "ECONNECTION") {
        return res.status(500).json({
          msg: "Network error sending email. Please try again in a few minutes.",
          error: process.env.NODE_ENV === "development" 
            ? `${emailError.code}: ${emailError.message}` 
            : undefined,
        });
      }

      return res.status(500).json({
        msg: "Failed to send verification email. Please try again later.",
        error: process.env.NODE_ENV === "development" 
          ? emailError.message 
          : undefined,
      });
    }
  } catch (err) {
    console.error("❌ RESEND VERIFICATION SERVER ERROR:");
    console.error("Error:", err);
    console.error("Stack:", err.stack);

    return res.status(500).json({
      msg: "Server error. Please try again.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};


exports.getMe = async (req, res) => {
  try {
    // Check cache first
    const cached = userCache.get(req.user.id);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.user);
    }

    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ msg: "User not found" });

    // Update cache
    userCache.set(req.user.id, {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isVerified: user.isVerified,
      },
      expiresAt: Date.now() + CACHE_TTL,
    });

    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};


exports.updateDeviceToken = async (req, res) => {
  const { deviceToken } = req.body;

  if (!deviceToken) {
    return res.status(400).json({ msg: "Device token is required" });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ msg: "User not found" });

    user.deviceToken = deviceToken;
    await user.save();

    clearUserCache(user.id);
    res.json({ msg: "Device token updated successfully" });
  } catch (err) {
    console.error(err);
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


exports.googleCallback = (req, res) => {
  const token = generateToken(req.user.id, true);
  res.redirect(`${config.frontendBaseUrl}/auth/callback?token=${token}`);
};

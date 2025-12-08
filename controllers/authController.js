// controllers/authController.js
"use strict";

const User = require("../models/User");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const crypto = require("crypto");
const { sendVerificationEmail } = require("../utils/email");
const { validationResult } = require("express-validator");

// In‑memory cache for /me payload
const userCache = new Map();
const CACHE_TTL = 300000; // 5 minutes

const generateToken = (userId, rememberMe = false) => {
  const payload = { user: { id: userId } };
  const expiresIn = rememberMe ? "30d" : "1d";
  return jwt.sign(payload, config.jwtSecret, { expiresIn });
};

const clearUserCache = (userId) => userCache.delete(userId);

exports.register = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ errors: errors.array() });

  const { username, email, password } = req.body;
  try {
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      if (existingUser.email === email)
        return res.status(400).json({ msg: "User already exists" });
      return res.status(400).json({ msg: "Username already taken" });
    }

    const user = new User({ username, email, password });
    user.verificationToken = crypto.randomBytes(32).toString("hex");
    user.verificationTokenExpires = Date.now() + 3600000;
    await user.save();

    const verifyUrl = `${config.frontendBaseUrl}/verify-email?token=${user.verificationToken}`;
    sendVerificationEmail(user.email, verifyUrl).catch((err) =>
      console.error("Email send error:", err)
    );

    res.json({
      msg: "Registration successful. Please check your email to verify.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};

exports.login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ errors: errors.array() });

  const { email, password, rememberMe } = req.body;
  try {
    const user = await User.findOne({ email }).select("+password");
    if (!user) return res.status(400).json({ msg: "Invalid credentials" });

    if (!user.googleId && !user.isVerified) {
      return res
        .status(400)
        .json({
          msg: "Email not verified. Please verify your email or use Google login.",
        });
    }

    if (!user.password) {
      return res
        .status(400)
        .json({
          msg: "This account uses Google login. Please sign in with Google.",
        });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    const token = generateToken(user.id, rememberMe);
    const userWithPrefs = {
      id: user.id,
      username: user.username,
      email: user.email,
      isVerified: user.isVerified,
      emailAlerts: user.emailAlerts ?? true,
      pushAlerts: user.pushAlerts ?? true,
      smsAlerts: user.smsAlerts ?? false,
    };
    userCache.set(user.id, {
      user: userWithPrefs,
      expiresAt: Date.now() + CACHE_TTL,
    });

    res.json({
      token,
      expiresIn: rememberMe ? "30d" : "1d",
      user: userWithPrefs,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};

exports.verifyEmail = async (req, res) => {
  const { token } = req.params;
  if (!token)
    return res.status(400).json({ msg: "Verification token is required" });

  try {
    const user = await User.findOne({
      verificationToken: token,
      verificationTokenExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        msg: "Invalid or expired verification token. Please request a new verification email.",
        expired: true,
      });
    }

    if (user.isVerified) {
      return res.json({
        msg: "Email already verified. You can log in now.",
        alreadyVerified: true,
        user: { email: user.email, username: user.username },
      });
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save();

    const jwtToken = generateToken(user.id, true);
    res.json({
      msg: "Email verified successfully! You can now log in.",
      success: true,
      token: jwtToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        isVerified: true,
      },
    });
  } catch (err) {
    console.error("❌ Email verification error:", err);
    res.status(500).json({
      msg: "Server error during verification",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

exports.resendVerification = async (req, res) => {
  const { email } = req.body;
  if (!email || !email.trim())
    return res.status(400).json({ msg: "Email is required" });

  try {
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) return res.status(404).json({ msg: "User not found" });
    if (user.isVerified)
      return res.status(400).json({ msg: "Email already verified" });
    if (user.googleId)
      return res
        .status(400)
        .json({
          msg: "This account uses Google login and is already verified",
        });

    user.verificationToken = crypto.randomBytes(32).toString("hex");
    user.verificationTokenExpires = Date.now() + 3600000;
    await user.save();

    const verifyUrl = `${config.frontendBaseUrl}/verify-email?token=${user.verificationToken}`;
    try {
      await sendVerificationEmail(user.email, verifyUrl);
      return res.json({
        msg: "Verification email resent. Please check your inbox.",
        success: true,
      });
    } catch (emailError) {
      console.error("❌ EMAIL SENDING ERROR:", emailError);
      if (emailError.code === "EAUTH") {
        return res.status(500).json({
          msg: "Email authentication failed. Please contact support.",
          error:
            process.env.NODE_ENV === "development"
              ? "SMTP authentication error"
              : undefined,
        });
      }
      if (emailError.code === "ESOCKET" || emailError.code === "ETIMEDOUT") {
        return res.status(500).json({
          msg: "Network error sending email. Please try again.",
          error:
            process.env.NODE_ENV === "development"
              ? "Socket/timeout error"
              : undefined,
        });
      }
      return res.status(500).json({
        msg: "Failed to send verification email. Please try again later.",
        error:
          process.env.NODE_ENV === "development"
            ? emailError.message
            : undefined,
      });
    }
  } catch (err) {
    console.error("❌ RESEND VERIFICATION SERVER ERROR:", err);
    return res.status(500).json({
      msg: "Server error. Please try again.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

exports.getMe = async (req, res) => {
  try {
    const userId = req.user.id;
    const cached = userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      const c = cached.user;
      return res.json({
        user: {
          ...c,
          emailAlerts: c.emailAlerts ?? true,
          pushAlerts: c.pushAlerts ?? true,
          smsAlerts: c.smsAlerts ?? false,
        },
      });
    }

    const user = await User.findById(userId)
      .select(
        "-password -googleId -verificationToken -verificationTokenExpires"
      )
      .lean();

    if (!user) return res.status(404).json({ msg: "User not found" });

    const withDefaults = {
      ...user,
      emailAlerts: user.emailAlerts ?? true,
      pushAlerts: user.pushAlerts ?? true,
      smsAlerts: user.smsAlerts ?? false,
    };

    userCache.set(userId, {
      user: withDefaults,
      expiresAt: Date.now() + CACHE_TTL,
    });
    res.json({ user: withDefaults });
  } catch (err) {
    console.error("Error in /me:", err);
    res.status(500).send("Server error");
  }
};

exports.updateProfile = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ errors: errors.array() });

  const { username, emailAlerts, pushAlerts, smsAlerts } = req.body;
  try {
    const userId = req.user.id;

    if (username && username !== req.user.username) {
      const exists = await User.findOne({ username });
      if (exists)
        return res.status(400).json({ msg: "Username already taken" });
    }

    const update = {
      ...(username && { username }),
      ...(emailAlerts !== undefined && { emailAlerts }),
      ...(pushAlerts !== undefined && { pushAlerts }),
      ...(smsAlerts !== undefined && { smsAlerts }),
    };

    const updatedUser = await User.findByIdAndUpdate(userId, update, {
      new: true,
      runValidators: true,
    }).select(
      "-password -googleId -verificationToken -verificationTokenExpires"
    );

    if (!updatedUser) return res.status(404).json({ msg: "User not found" });

    clearUserCache(userId);

    res.json({
      msg: "Profile updated successfully",
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        isVerified: updatedUser.isVerified,
        emailAlerts: updatedUser.emailAlerts,
        pushAlerts: updatedUser.pushAlerts,
        smsAlerts: updatedUser.smsAlerts,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error" });
  }
};

exports.changePassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ errors: errors.array() });

  const { currentPassword, newPassword } = req.body;
  try {
    const user = await User.findById(req.user.id).select("+password");
    if (!user) return res.status(404).json({ msg: "User not found" });

    if (!user.password) {
      return res
        .status(400)
        .json({
          msg: "This account uses Google login. Password changes are not supported.",
        });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch)
      return res.status(400).json({ msg: "Incorrect current password" });

    if (String(newPassword).length < 6) {
      return res
        .status(400)
        .json({ msg: "New password must be at least 6 characters" });
    }

    user.password = newPassword;
    await user.save();

    clearUserCache(req.user.id);
    res.json({ msg: "Password updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error" });
  }
};

exports.googleCallback = (req, res) => {
  const token = generateToken(req.user.id, true);
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

// Purge expired cache entries
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of userCache.entries()) {
    if (data.expiresAt < now) userCache.delete(userId);
  }
}, 300000);

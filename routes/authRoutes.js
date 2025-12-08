// routes/authRoutes.js
"use strict";

const express = require("express");
const { check } = require("express-validator");
const passport = require("passport");

const router = express.Router();
const authController = require("../controllers/authController");
const authMiddleware = require("../middlewares/authMiddleware");

// Register
router.post(
  "/register",
  [
    check("username", "Username is required").not().isEmpty(),
    check("email", "Please include a valid email").isEmail(),
    check("password", "Password must be 6+ characters").isLength({ min: 6 }),
  ],
  authController.register
);

// Login (with remember me)
router.post(
  "/login",
  [
    check("email", "Please include a valid email").isEmail(),
    check("password", "Password is required").exists(),
  ],
  authController.login
);

// Email verification
router.post("/resend-verification", authController.resendVerification);
router.get("/verify/:token", authController.verifyEmail);

// Protected
router.get("/me", authMiddleware, authController.getMe);
router.post("/update-token", authMiddleware, authController.updateDeviceToken);
router.post("/logout", authMiddleware, authController.logout);

// Update profile
const updateProfileValidation = [
  check("username")
    .optional()
    .not()
    .isEmpty()
    .withMessage("Username is required"),
  check("username")
    .optional()
    .isLength({ min: 3, max: 20 })
    .withMessage("Username must be 3-20 characters"),
  check("emailAlerts")
    .optional()
    .isBoolean()
    .withMessage("Invalid email alerts preference"),
  check("pushAlerts")
    .optional()
    .isBoolean()
    .withMessage("Invalid push alerts preference"),
  check("smsAlerts")
    .optional()
    .isBoolean()
    .withMessage("Invalid SMS alerts preference"),
];
router.put(
  "/update-profile",
  updateProfileValidation,
  authMiddleware,
  authController.updateProfile
);

// Change password
const changePasswordValidation = [
  check("currentPassword")
    .not()
    .isEmpty()
    .withMessage("Current password is required"),
  check("newPassword")
    .not()
    .isEmpty()
    .withMessage("New password is required")
    .isLength({ min: 6 })
    .withMessage("New password must be at least 6 characters"),
];
router.put(
  "/change-password",
  changePasswordValidation,
  authMiddleware,
  authController.changePassword
);

// Google OAuth
router.get(
  "/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  authController.googleCallback
);

module.exports = router;

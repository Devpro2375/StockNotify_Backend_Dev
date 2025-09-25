// routes/marketDataRoutes.js

const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const marketDataController = require("../controllers/marketDataController");

router.get("/quotes", authMiddleware, marketDataController.getQuotes);

module.exports = router;

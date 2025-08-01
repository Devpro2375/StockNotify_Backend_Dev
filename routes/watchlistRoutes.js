// routes\watchlistRoutes.js

const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const watchlistController = require("../controllers/watchlistController");

router.get("/", authMiddleware, watchlistController.getWatchlist);
router.post("/add", authMiddleware, watchlistController.addSymbol);
router.post("/remove", authMiddleware, watchlistController.removeSymbol);

module.exports = router;

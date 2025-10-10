const express = require('express');
const router = express.Router();
const telegramService = require('../services/telegramService');
const User = require('../models/User');

// Passport authentication middleware
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ message: 'Authentication required' });
}

// Webhook endpoint (for production)
router.post('/webhook', async (req, res) => {
  try {
    await telegramService.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.sendStatus(500);
  }
});

// Link Telegram account
router.post('/link', ensureAuthenticated, async (req, res) => {
  try {
    const { chatId } = req.body;

    if (!chatId || chatId.trim() === '') {
      return res.status(400).json({ message: 'Chat ID is required' });
    }

    // Validate chat ID format (should be numeric)
    if (!/^\d+$/.test(chatId.trim())) {
      return res.status(400).json({ 
        message: 'Invalid Chat ID format. It should be a numeric value.' 
      });
    }

    // Test if chat exists
    try {
      await telegramService.bot.sendChatAction(chatId.trim(), 'typing');
    } catch (error) {
      if (error.message.includes('chat not found')) {
        return res.status(400).json({ 
          message: 'Chat not found. Please send /start to the bot first, then try again.' 
        });
      }
    }

    // Check if already linked to another user
    const existingUser = await User.findOne({ 
      telegramChatId: chatId.toString(),
      _id: { $ne: req.user.id || req.user._id }
    });

    if (existingUser) {
      return res.status(400).json({ 
        message: 'This Telegram account is already linked to another user' 
      });
    }

    // Update user
    const user = await User.findByIdAndUpdate(
      req.user.id || req.user._id,
      {
        telegramChatId: chatId.toString(),
        telegramEnabled: true,
        telegramLinkedAt: new Date()
      },
      { new: true }
    );

    // Send confirmation (plain text)
    await telegramService.sendMessage(
      chatId,
      `✅ Account linked successfully!\n\n👤 User: ${user.name}\n📧 Email: ${user.email}\n\nYou'll now receive real-time stock alerts here. 🚀`
    );

    res.json({ 
      message: 'Telegram linked successfully',
      telegramEnabled: true 
    });
  } catch (error) {
    console.error('❌ Link error:', error);
    res.status(500).json({ message: 'Error linking Telegram account' });
  }
});

// Unlink Telegram account
router.post('/unlink', ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);

    if (!user.telegramChatId) {
      return res.status(400).json({ message: 'No Telegram account linked' });
    }

    const chatId = user.telegramChatId;

    // Update user
    user.telegramChatId = null;
    user.telegramUsername = null;
    user.telegramEnabled = false;
    await user.save();

    // Send confirmation
    await telegramService.sendMessage(
      chatId,
      '✅ Account unlinked successfully. Use /start to link again if needed.'
    );

    res.json({ message: 'Telegram unlinked successfully' });
  } catch (error) {
    console.error('❌ Unlink error:', error);
    res.status(500).json({ message: 'Error unlinking Telegram account' });
  }
});

// Get Telegram status
router.get('/status', ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);

    res.json({
      linked: !!user.telegramChatId,
      enabled: user.telegramEnabled || false,
      chatId: user.telegramChatId || null,
      linkedAt: user.telegramLinkedAt || null
    });
  } catch (error) {
    console.error('❌ Status error:', error);
    res.status(500).json({ message: 'Error fetching Telegram status' });
  }
});

// Toggle Telegram notifications
router.post('/toggle', ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);

    if (!user.telegramChatId) {
      return res.status(400).json({ message: 'No Telegram account linked' });
    }

    user.telegramEnabled = !user.telegramEnabled;
    await user.save();

    res.json({ 
      message: `Telegram notifications ${user.telegramEnabled ? 'enabled' : 'disabled'}`,
      enabled: user.telegramEnabled 
    });
  } catch (error) {
    console.error('❌ Toggle error:', error);
    res.status(500).json({ message: 'Error toggling notifications' });
  }
});

// Test notification
router.post('/test', ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);

    if (!user.telegramChatId) {
      return res.status(400).json({ message: 'No Telegram account linked' });
    }

    if (!user.telegramEnabled) {
      return res.status(400).json({ message: 'Telegram notifications are disabled. Enable them first.' });
    }

    await telegramService.sendMessage(
      user.telegramChatId,
      `🧪 Test Notification\n\nThis is a test message from Stock Alerts Bot.\n\nYour notifications are working perfectly! ✅`
    );

    res.json({ message: 'Test notification sent successfully' });
  } catch (error) {
    console.error('❌ Test error:', error);
    res.status(500).json({ message: 'Error sending test notification' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const config = require('../config/config');
const AccessToken = require('../models/AccessToken');
const axios = require('axios');
const upstoxService = require('../services/upstoxService'); // NEW: Require upstoxService to trigger reconnect

// Middleware to check if admin is logged in
const isAdminLoggedIn = (req, res, next) => {
  if (req.session.adminLoggedIn) {
    next();
  } else {
    res.redirect('/admin/login');
  }
};

// GET /admin/login - Serve login form
router.get('/login', (req, res) => {
  if (req.session.adminLoggedIn) {
    return res.redirect('/admin');
  }
  res.send(`
    <html>
      <head>
        <title>Admin Login</title>
        <style>
          body { font-family: Arial, sans-serif; background: #121212; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
          .container { background: #1e1e1e; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.3); width: 100%; max-width: 400px; }
          h1 { text-align: center; color: #E50914; }
          form { display: flex; flex-direction: column; }
          label { margin-bottom: 0.5rem; color: #FFD369; }
          input { padding: 0.75rem; margin-bottom: 1rem; border: 1px solid #333; border-radius: 4px; background: #2a2a2a; color: #fff; }
          button { padding: 0.75rem; background: #E50914; color: #fff; border: none; border-radius: 4px; cursor: pointer; transition: background 0.3s; }
          button:hover { background: #c40812; }
          .toggle { display: flex; align-items: center; margin-bottom: 1rem; }
          .toggle input { margin-right: 0.5rem; }
          @media (max-width: 600px) { .container { padding: 1rem; } }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Admin Login</h1>
          <form method="POST" action="/admin/login">
            <label for="password">Password:</label>
            <input type="password" id="password" name="password" required aria-label="Admin Password">
            <div class="toggle">
              <input type="checkbox" id="showPassword" onclick="togglePassword()">
              <label for="showPassword">Show Password</label>
            </div>
            <button type="submit">Login</button>
          </form>
        </div>
        <script>
          function togglePassword() {
            const input = document.getElementById('password');
            input.type = input.type === 'password' ? 'text' : 'password';
          }
        </script>
      </body>
    </html>
  `);
});

// POST /admin/login - Handle login
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === config.adminPassword) {
    req.session.adminLoggedIn = true;
    res.redirect('/admin');
  } else {
    res.status(401).send(`
      <html>
        <body style="background: #121212; color: #fff; text-align: center; padding: 2rem;">
          <h1 style="color: #E50914;">Invalid password.</h1>
          <a href="/admin/login" style="color: #FFD369;">Try again</a>
        </body>
      </html>
    `);
  }
});

// GET /admin - Serve dashboard (protected)
router.get('/', isAdminLoggedIn, async (req, res) => {
  try {
    const tokenDoc = await AccessToken.findOne();
    const currentToken = tokenDoc ? tokenDoc.token : '';
    const lastUpdated = tokenDoc ? new Date(tokenDoc.updatedAt).toLocaleString() : 'Never';
    res.send(`
      <html>
        <head>
          <title>Admin Dashboard</title>
          <style>
            body { font-family: Arial, sans-serif; background: #121212; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
            .container { background: #1e1e1e; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 16px rgba(0,0,0,0.4); width: 100%; max-width: 500px; }
            h1 { text-align: center; color: #E50914; font-size: 2rem; margin-bottom: 1.5rem; }
            p { margin: 0.5rem 0; color: #FFD369; font-size: 1rem; }
            form { display: flex; flex-direction: column; }
            label { margin-bottom: 0.5rem; color: #FFD369; font-weight: bold; }
            input { padding: 0.75rem; margin-bottom: 1rem; border: 1px solid #333; border-radius: 6px; background: #2a2a2a; color: #fff; font-size: 1rem; }
            button { padding: 0.75rem; background: #E50914; color: #fff; border: none; border-radius: 6px; cursor: pointer; transition: background 0.3s, transform 0.2s; margin-bottom: 1rem; font-size: 1rem; font-weight: bold; }
            button:hover { background: #c40812; transform: translateY(-2px); }
            .message { padding: 1rem; background: #2a2a2a; border-radius: 6px; margin-bottom: 1rem; text-align: center; display: none; font-size: 1rem; }
            .success { background: #1b5e20; }
            .error { background: #b71c1c; }
            a { color: #FFD369; text-decoration: none; font-size: 1rem; }
            a:hover { text-decoration: underline; }
            #connectionStatus { display: flex; align-items: center; justify-content: center; margin: 1rem 0; font-size: 1.1rem; font-weight: bold; }
            .status-dot { width: 12px; height: 12px; border-radius: 50%; margin-right: 0.5rem; }
            .connected .status-dot { background: #4caf50; }
            .not-connected .status-dot { background: #f44336; }
            @media (max-width: 600px) { .container { padding: 1.5rem; } }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Admin Dashboard</h1>
            <p>Current Token: ${currentToken}</p>
            <p>Last Updated: ${lastUpdated}</p>
            <div id="connectionStatus"><div class="status-dot"></div> Checking...</div>
            <div id="message" class="message"></div>
            <form method="POST" action="/admin/update-token" onsubmit="return validateForm()">
              <label for="token">New Access Token:</label>
              <input type="text" id="token" name="token" required aria-label="New Access Token">
              <button type="submit">Update Token</button>
            </form>
            <button onclick="testToken(true)">Test Current Token</button>
            <a href="/admin/logout" onclick="return confirm('Are you sure you want to logout?');">Logout</a>
          </div>
          <script>
            function showMessage(text, type) {
              const msg = document.getElementById('message');
              msg.textContent = text;
              msg.className = 'message ' + type;
              msg.style.display = 'block';
              setTimeout(() => { msg.style.display = 'none'; }, 5000);
            }

            function validateForm() {
              const token = document.getElementById('token').value;
              if (!token.trim()) {
                showMessage('Token cannot be empty.', 'error');
                return false;
              }
              return true;
            }

            async function testToken(showMsg) {
              console.log('Starting token test...');
              try {
                const response = await fetch('/admin/test-token', { method: 'POST' });
                console.log('Fetch response status:', response.status);
                if (!response.ok) {
                  throw new Error('Network response was not ok');
                }
                const result = await response.json();
                console.log('Test result:', result);
                const status = document.getElementById('connectionStatus');
                if (result.valid) {
                  status.innerHTML = '<div class="status-dot"></div> Connected';
                  status.className = 'connected';
                  if (showMsg) showMessage('Token is valid!', 'success');
                } else {
                  status.innerHTML = '<div class="status-dot"></div> Not Connected';
                  status.className = 'not-connected';
                  if (showMsg) showMessage('Token is invalid or expired.', 'error');
                }
              } catch (err) {
                console.error('Error in testToken:', err);
                const status = document.getElementById('connectionStatus');
                status.innerHTML = '<div class="status-dot"></div> Not Connected';
                status.className = 'not-connected';
                if (showMsg) showMessage('Error testing token: ' + err.message, 'error');
              }
            }

            // Auto-test on page load without message
            window.addEventListener('load', () => testToken(false));

            // Handle query params for messages
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.has('success')) showMessage(urlParams.get('success'), 'success');
            if (urlParams.has('error')) showMessage(urlParams.get('error'), 'error');
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error loading dashboard.');
  }
});

// POST /admin/update-token - Update token in DB and trigger reconnect
router.post('/update-token', isAdminLoggedIn, async (req, res) => {
  const { token } = req.body;
  try {
    await AccessToken.updateOne({}, { token, updatedAt: Date.now() }, { upsert: true });
    // NEW: Trigger reconnect to apply the new token immediately
    await upstoxService.connect();
    res.redirect('/admin?success=Token updated and connection refreshed successfully!');
  } catch (err) {
    console.error('Error updating token or reconnecting:', err);
    res.redirect('/admin?error=Failed to update token or refresh connection.');
  }
});

// POST /admin/test-token - Test token validity
router.post('/test-token', isAdminLoggedIn, async (req, res) => {
  try {
    const tokenDoc = await AccessToken.findOne();
    if (!tokenDoc || !tokenDoc.token) {
      return res.json({ valid: false });
    }
    // Updated: Use a valid Upstox endpoint for testing (e.g., user profile in v2)
    await axios.get('https://api.upstox.com/v2/user/profile', {
      headers: { Authorization: `Bearer ${tokenDoc.token}` }
    });
    res.json({ valid: true });
  } catch (err) {
    console.error('Test token error:', err.response ? err.response.data : err.message);
    res.json({ valid: false });
  }
});

// GET /admin/logout - Logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

module.exports = router;

const nodemailer = require('nodemailer');
const config = require('../config/config');

// PRODUCTION-GRADE TRANSPORTER CONFIGURATION
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false, // Use TLS
  requireTLS: true, // Force TLS
  auth: {
    user: config.emailUser,
    pass: config.emailPass
  },
  // Connection pool settings for production
  pool: true,
  maxConnections: 5,
  maxMessages: 100,
  rateDelta: 1000,
  rateLimit: 5,
  // Timeout settings
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
  // Debug mode
  logger: process.env.NODE_ENV === 'development',
  debug: process.env.NODE_ENV === 'development'
});

// VERIFY CONNECTION ON STARTUP
let isTransporterReady = false;

const verifyTransporter = async () => {
  try {
    await transporter.verify();
    isTransporterReady = true;
    console.log('✅ Email transporter verified and ready');
    return true;
  } catch (error) {
    isTransporterReady = false;
    console.error('❌ Email transporter verification failed:', error.message);
    console.error('Check EMAIL_USER and EMAIL_PASS environment variables');
    return false;
  }
};

// Verify immediately on module load
verifyTransporter().catch(err => {
  console.error('Failed to verify email transporter on startup:', err);
});

// Re-verify every 5 minutes
setInterval(() => {
  verifyTransporter().catch(err => {
    console.error('Periodic email transporter verification failed:', err);
  });
}, 5 * 60 * 1000);

// EXISTING: Verification email functionality
exports.sendVerificationEmail = async (to, verifyUrl) => {
  if (!isTransporterReady) {
    await verifyTransporter();
    if (!isTransporterReady) {
      throw new Error('Email service not available - SMTP connection failed');
    }
  }

  const mailOptions = {
    from: `"Stock Notify" <${config.emailUser}>`,
    to,
    subject: 'Verify Your Email - Stock Notify',
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Your Email</title>
        <style>
          body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; color: #333; }
          .container { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); padding: 40px; }
          .header { text-align: center; margin-bottom: 30px; }
          .header h1 { color: #007bff; font-size: 24px; }
          .content { font-size: 16px; line-height: 1.5; margin-bottom: 30px; }
          .button { display: inline-block; background-color: #007bff; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; }
          .footer { text-align: center; font-size: 12px; color: #777; margin-top: 40px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to Stock Notify!</h1>
          </div>
          <div class="content">
            <p>Thank you for registering with Stock Notify. To complete your registration and activate your account, please verify your email address by clicking the button below.</p>
            <p style="text-align: center;">
              <a href="${verifyUrl}" class="button">Verify My Email</a>
            </p>
            <p>If you did not create an account with Stock Notify, please ignore this email.</p>
            <p>Best regards,<br>Stock Notify Team</p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} Stock Notify. All rights reserved.<br>
            If you have any questions, contact us at support@stocknotify.com.
          </div>
        </div>
      </body>
      </html>
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Verification email sent to ${to} - MessageID: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error(`❌ Failed to send verification email to ${to}:`, error.message);
    throw error;
  }
};

// PRODUCTION-GRADE: Alert notification email with retry logic
exports.sendAlertNotification = async (userEmail, alertDetails, retryCount = 0) => {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2000;

  if (!isTransporterReady) {
    await verifyTransporter();
    if (!isTransporterReady) {
      throw new Error('Email service not available - SMTP connection failed');
    }
  }

  const {
    trading_symbol,
    status,
    current_price,
    entry_price,
    stop_loss,
    target_price,
    trend,
    trade_type,
    triggered_at
  } = alertDetails;

  const statusConfig = {
    slHit: {
      title: 'Stop Loss Hit',
      color: '#dc3545',
      icon: '🛑',
      message: 'Your stop loss has been triggered!',
      advice: 'Review your position and consider your next strategy.'
    },
    targetHit: {
      title: 'Target Reached',
      color: '#28a745',
      icon: '🎯',
      message: 'Congratulations! Your target has been achieved!',
      advice: 'Consider booking profits or trailing your position.'
    },
    enter: {
      title: 'Entry Condition Met',
      color: '#007bff',
      icon: '🚀',
      message: 'Entry conditions have been satisfied!',
      advice: 'Consider entering your position as planned.'
    }
  };

  const configData = statusConfig[status] || statusConfig.enter;

  const formatCurrency = (amount) => `₹${amount.toFixed(2)}`;
  const formatDateTime = (date) => new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const calculatePnL = () => {
    if (status === 'slHit' || status === 'targetHit') {
      const pnl = current_price - entry_price;
      const pnlPercent = ((pnl / entry_price) * 100);
      return {
        amount: pnl,
        percent: pnlPercent,
        isProfit: pnl > 0
      };
    }
    return null;
  };

  const pnl = calculatePnL();

  const mailOptions = {
    from: `"Stock Notify Alerts" <${config.emailUser}>`,
    to: userEmail,
    subject: `${configData.icon} ${trading_symbol} Alert: ${configData.title}`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Stock Alert - ${trading_symbol}</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            background-color: #f8f9fa; 
            margin: 0; 
            padding: 20px; 
            color: #212529; 
            line-height: 1.6;
          }
          .container { 
            max-width: 600px; 
            margin: 0 auto; 
            background: #ffffff; 
            border-radius: 12px; 
            box-shadow: 0 4px 25px rgba(0,0,0,0.1); 
            overflow: hidden; 
          }
          .header { 
            background: linear-gradient(135deg, ${configData.color}, ${configData.color}dd); 
            color: white; 
            padding: 30px; 
            text-align: center; 
          }
          .header-icon { font-size: 48px; margin-bottom: 10px; }
          .header h1 { margin: 0; font-size: 28px; font-weight: 700; }
          .header .subtitle { margin: 10px 0 0 0; font-size: 16px; opacity: 0.9; }
          .content { padding: 30px; }
          .alert-card { 
            background: linear-gradient(135deg, #f8f9fa, #ffffff); 
            border-radius: 12px; 
            padding: 25px; 
            margin: 20px 0; 
            border: 1px solid #e9ecef;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
          }
          .stock-header { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #e9ecef;
          }
          .stock-name { font-size: 24px; font-weight: 700; color: #212529; }
          .current-price { 
            font-size: 28px; 
            font-weight: 800; 
            color: ${configData.color}; 
            text-align: right;
          }
          .price-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); 
            gap: 15px; 
            margin: 20px 0; 
          }
          .price-item { 
            background: white; 
            padding: 15px; 
            border-radius: 8px; 
            border: 1px solid #dee2e6; 
            text-align: center;
          }
          .price-label { 
            font-size: 12px; 
            color: #6c757d; 
            text-transform: uppercase; 
            font-weight: 600; 
            margin-bottom: 8px; 
          }
          .price-value { 
            font-size: 18px; 
            font-weight: 700; 
            color: #212529; 
          }
          .meta-info { 
            display: grid; 
            grid-template-columns: 1fr 1fr; 
            gap: 15px; 
            margin-top: 20px; 
          }
          .trend-badge { 
            display: inline-block; 
            padding: 6px 12px; 
            border-radius: 20px; 
            font-size: 12px; 
            font-weight: 600; 
            text-transform: uppercase; 
          }
          .trend-bullish { background: #d4edda; color: #155724; }
          .trend-bearish { background: #f8d7da; color: #721c24; }
          .trade-type { 
            background: #e3f2fd; 
            color: #1565c0; 
            padding: 6px 12px; 
            border-radius: 20px; 
            font-size: 12px; 
            font-weight: 600; 
            text-transform: uppercase; 
          }
          .pnl-section { 
            background: ${pnl?.isProfit ? '#d4edda' : '#f8d7da'}; 
            color: ${pnl?.isProfit ? '#155724' : '#721c24'}; 
            padding: 15px; 
            border-radius: 8px; 
            margin: 20px 0; 
            text-align: center;
          }
          .pnl-amount { font-size: 20px; font-weight: 700; }
          .advice-box { 
            background: #e3f2fd; 
            border-left: 4px solid #2196f3; 
            padding: 15px; 
            border-radius: 6px; 
            margin: 20px 0; 
          }
          .advice-title { font-weight: 600; color: #1565c0; margin-bottom: 5px; }
          .timestamp { 
            text-align: center; 
            padding: 20px; 
            border-top: 1px solid #e9ecef; 
            background: #f8f9fa; 
            color: #6c757d; 
            font-size: 14px; 
          }
          .footer { 
            background: #343a40; 
            color: #ffffff; 
            padding: 20px; 
            text-align: center; 
            font-size: 12px; 
          }
          .footer a { color: #ffc107; text-decoration: none; }
          @media (max-width: 600px) {
            .content { padding: 20px; }
            .stock-header { flex-direction: column; text-align: center; }
            .current-price { text-align: center; margin-top: 10px; }
            .price-grid { grid-template-columns: 1fr; }
            .meta-info { grid-template-columns: 1fr; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="header-icon">${configData.icon}</div>
            <h1>Alert Triggered!</h1>
            <div class="subtitle">${configData.message}</div>
          </div>
          
          <div class="content">
            <div class="alert-card">
              <div class="stock-header">
                <div class="stock-name">${trading_symbol}</div>
                <div class="current-price">${formatCurrency(current_price)}</div>
              </div>
              
              <div class="price-grid">
                <div class="price-item">
                  <div class="price-label">Entry Price</div>
                  <div class="price-value">${formatCurrency(entry_price)}</div>
                </div>
                <div class="price-item">
                  <div class="price-label">Stop Loss</div>
                  <div class="price-value">${formatCurrency(stop_loss)}</div>
                </div>
                <div class="price-item">
                  <div class="price-label">Target Price</div>
                  <div class="price-value">${formatCurrency(target_price)}</div>
                </div>
              </div>

              ${pnl ? `
                <div class="pnl-section">
                  <div class="pnl-amount">
                    ${pnl.isProfit ? '📈' : '📉'} P&L: ${formatCurrency(pnl.amount)} (${pnl.percent.toFixed(2)}%)
                  </div>
                </div>
              ` : ''}
              
              <div class="meta-info">
                <div>
                  <strong>Trend:</strong>
                  <span class="trend-badge ${trend === 'bullish' ? 'trend-bullish' : 'trend-bearish'}">${trend}</span>
                </div>
                <div>
                  <strong>Type:</strong>
                  <span class="trade-type">${trade_type}</span>
                </div>
              </div>
            </div>
            
            <div class="advice-box">
              <div class="advice-title">💡 Recommended Action</div>
              <div>${configData.advice}</div>
            </div>
          </div>
          
          <div class="timestamp">
            <strong>Alert Time:</strong> ${formatDateTime(triggered_at)} (IST)
          </div>
          
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Stock Notify. All rights reserved.</p>
            <p>This is an automated alert notification. Please do not reply to this email.</p>
            <p>Questions? Contact us at <a href="mailto:support@stocknotify.com">support@stocknotify.com</a></p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Alert email sent to ${userEmail} for ${trading_symbol} - MessageID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ Failed to send alert email (attempt ${retryCount + 1}/${MAX_RETRIES}) to ${userEmail}:`, error.message);
    
    if (retryCount < MAX_RETRIES && isRetryableError(error)) {
      console.log(`🔄 Retrying email send in ${RETRY_DELAY}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return exports.sendAlertNotification(userEmail, alertDetails, retryCount + 1);
    }
    
    throw error;
  }
};

function isRetryableError(error) {
  const retryableErrors = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'];
  return retryableErrors.some(errCode => error.code === errCode || error.message.includes(errCode));
}

process.on('SIGTERM', () => {
  transporter.close();
  console.log('Email transporter closed');
});

process.on('SIGINT', () => {
  transporter.close();
  console.log('Email transporter closed');
});

exports.transporter = transporter;
exports.verifyTransporter = verifyTransporter;
exports.isTransporterReady = () => isTransporterReady;

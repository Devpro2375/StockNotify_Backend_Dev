const nodemailer = require('nodemailer');
const config = require('../config/config');

const transporter = nodemailer.createTransport({
  host: config.emailHost,
  port: config.emailPort,
  secure: false, // Use true for 465, false for other ports
  auth: {
    user: config.emailUser,
    pass: config.emailPass
  }
});

exports.sendVerificationEmail = async (to, verifyUrl) => {
  const mailOptions = {
    from: config.emailUser,
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
          .button { display: inline-block; background-color: #007bff; color: #ffffff; text: #ffffff;  padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; }
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

  await transporter.sendMail(mailOptions);
};

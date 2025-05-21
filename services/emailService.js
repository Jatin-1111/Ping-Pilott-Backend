import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';

// Create a reusable transporter object
let transporter = null;

/**
 * Initialize the email transporter
 * @returns {Object} Email transporter
 */
export const initTransporter = () => {
  if (transporter) return transporter;

  // Check for required environment variables
  if (
    !process.env.SMTP_HOST ||
    !process.env.SMTP_PORT ||
    !process.env.SMTP_USER ||
    !process.env.SMTP_PASSWORD
  ) {
    logger.warn('Email configuration incomplete. Email features will be disabled.');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
    // Pool connections for better performance
    pool: true,
    // Max number of connections to make at once
    maxConnections: 5,
    // Max number of messages to send per connection
    maxMessages: 100,
    // Number of milliseconds to wait for sending a message
    socketTimeout: 30000,
  });

  logger.info('Email transporter initialized');
  return transporter;
};

/**
 * Send alert email for server status change
 * @param {Object} server - Server object
 * @param {String} alertType - Type of alert: 'server_down', 'server_recovery', 'slow_response'
 * @param {String} oldStatus - Previous status
 * @param {String} newStatus - New status
 * @returns {Boolean} Whether the email was sent
 */
export const sendAlertEmail = async (server, alertType, oldStatus, newStatus) => {
  // Get or initialize transporter
  const mailer = initTransporter();
  if (!mailer) {
    logger.warn('Cannot send alert email: email service not configured');
    return false;
  }

  try {
    // Verify SMTP connection
    await mailer.verify();

    // Prepare email content
    const { subject, html } = getAlertEmailContent(server, alertType, oldStatus, newStatus);

    // Get from email or use default
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@pingpilot.com';

    // Send email to all contacts
    for (const email of server.contactEmails) {
      const info = await mailer.sendMail({
        from: `"Ping Pilot" <${fromEmail}>`,
        to: email,
        subject,
        html,
      });

      logger.info(`Alert email sent to ${email}: ${info.messageId}`);
    }

    return true;
  } catch (error) {
    logger.error(`Error sending alert email for ${server.name}: ${error.message}`);
    return false;
  }
};

/**
 * Get email content for different alert types
 * @param {Object} server - Server object
 * @param {String} alertType - Type of alert
 * @param {String} oldStatus - Previous status
 * @param {String} newStatus - New status
 * @returns {Object} Email subject and HTML content
 */
const getAlertEmailContent = (server, alertType, oldStatus, newStatus) => {
  const serverName = server.name;
  const serverUrl = server.url;
  const currentTime = new Date().toLocaleString();
  const responseTime = server.responseTime ? `${server.responseTime}ms` : 'Unknown';
  const responseThreshold = server.monitoring?.alerts?.responseThreshold || 1000;
  const errorMessage = server.error || 'Unknown error';

  let subject;
  let html;

  switch (alertType) {
    case 'server_down':
      subject = `🚨 ALERT: ${serverName} is DOWN`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #f44336; color: white; padding: 15px; text-align: center;">
            <h1 style="margin: 0;">Server Down Alert</h1>
          </div>
          <div style="padding: 20px; border: 1px solid #ddd; background-color: #f9f9f9;">
            <p>Your server <strong>${serverName}</strong> is currently <strong style="color: red;">DOWN</strong>.</p>
            <p>URL: ${serverUrl}</p>
            <p>Time of detection: ${currentTime}</p>
            <p>Error: ${errorMessage}</p>
            <p>We'll notify you when the server is back online.</p>
            <p style="margin-top: 30px; font-size: 12px; color: #777;">
              This is an automated message from Ping Pilot monitoring.
            </p>
          </div>
        </div>
      `;
      break;

    case 'server_recovery':
      subject = `✅ RESOLVED: ${serverName} is back UP`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4CAF50; color: white; padding: 15px; text-align: center;">
            <h1 style="margin: 0;">Server Recovery Alert</h1>
          </div>
          <div style="padding: 20px; border: 1px solid #ddd; background-color: #f9f9f9;">
            <p>Your server <strong>${serverName}</strong> is now <strong style="color: green;">UP</strong> again.</p>
            <p>URL: ${serverUrl}</p>
            <p>Time of recovery: ${currentTime}</p>
            <p>Current response time: ${responseTime}</p>
            <p style="margin-top: 30px; font-size: 12px; color: #777;">
              This is an automated message from Ping Pilot monitoring.
            </p>
          </div>
        </div>
      `;
      break;

    case 'slow_response':
      subject = `⚠️ WARNING: ${serverName} is responding slowly`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #ff9800; color: white; padding: 15px; text-align: center;">
            <h1 style="margin: 0;">Server Performance Warning</h1>
          </div>
          <div style="padding: 20px; border: 1px solid #ddd; background-color: #f9f9f9;">
            <p>Your server <strong>${serverName}</strong> is <strong style="color: orange;">responding slowly</strong>.</p>
            <p>URL: ${serverUrl}</p>
            <p>Time of detection: ${currentTime}</p>
            <p>Current response time: ${responseTime} (threshold: ${responseThreshold}ms)</p>
            <p style="margin-top: 30px; font-size: 12px; color: #777;">
              This is an automated message from Ping Pilot monitoring.
            </p>
          </div>
        </div>
      `;
      break;

    default:
      subject = `🔔 NOTIFICATION: ${serverName} status update`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #2196F3; color: white; padding: 15px; text-align: center;">
            <h1 style="margin: 0;">Server Status Update</h1>
          </div>
          <div style="padding: 20px; border: 1px solid #ddd; background-color: #f9f9f9;">
            <p>Your server <strong>${serverName}</strong> has changed status from <strong>${oldStatus}</strong> to <strong>${newStatus}</strong>.</p>
            <p>URL: ${serverUrl}</p>
            <p>Time of detection: ${currentTime}</p>
            <p>Response time: ${responseTime}</p>
            <p style="margin-top: 30px; font-size: 12px; color: #777;">
              This is an automated message from Ping Pilot monitoring.
            </p>
          </div>
        </div>
      `;
  }

  return { subject, html };
};

/**
 * Send verification email to user
 * @param {Object} user - User object
 * @param {String} verificationToken - Verification token
 * @returns {Boolean} Whether the email was sent
 */
export const sendVerificationEmail = async (user, verificationToken) => {
  // Get or initialize transporter
  const mailer = initTransporter();
  if (!mailer) {
    logger.warn('Cannot send verification email: email service not configured');
    return false;
  }

  try {
    // Verify SMTP connection
    await mailer.verify();

    // Get from email or use default
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@pingpilot.com';

    // Create verification link
    const verificationLink = `${process.env.FRONTEND_URL || 'http://pingpilott.vercel.app'}/auth/verify-email?token=${verificationToken}&userId=${user.id}`;

    const info = await mailer.sendMail({
      from: `"Ping Pilot" <${fromEmail}>`,
      to: user.email,
      subject: 'Verify Your Email - Ping Pilot',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #2196F3; color: white; padding: 15px; text-align: center;">
            <h1 style="margin: 0;">Email Verification</h1>
          </div>
          <div style="padding: 20px; border: 1px solid #ddd; background-color: #f9f9f9;">
            <h2>Hello${user.name ? ` ${user.name}` : ''},</h2>
            <p>Thank you for signing up for Ping Pilot. Please verify your email by clicking the button below:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${verificationLink}" style="display: inline-block; padding: 10px 20px; background-color: #1D4ED8; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
                Verify Email
              </a>
            </div>
            <p>If you didn't request this, please ignore this email.</p>
            <p>This link will expire in 24 hours.</p>
            <p>Best regards,<br>Team Ping Pilot</p>
          </div>
        </div>
      `,
    });

    logger.info(`Verification email sent to ${user.email}: ${info.messageId}`);
    return true;
  } catch (error) {
    logger.error(`Error sending verification email for ${user.email}: ${error.message}`);
    return false;
  }
};

/**
 * Send password reset email
 * @param {Object} user - User object
 * @param {String} resetToken - Reset token
 * @returns {Boolean} Whether the email was sent
 */
export const sendPasswordResetEmail = async (user, resetToken) => {
  // Get or initialize transporter
  const mailer = initTransporter();
  if (!mailer) {
    logger.warn('Cannot send password reset email: email service not configured');
    return false;
  }

  try {
    // Verify SMTP connection
    await mailer.verify();

    // Get from email or use default
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@pingpilot.com';

    // Create reset link
    const resetLink = `${process.env.FRONTEND_URL || 'http://pingpilott.vercel.app'}/auth/reset-password?token=${resetToken}&userId=${user.id}`;

    const info = await mailer.sendMail({
      from: `"Ping Pilot" <${fromEmail}>`,
      to: user.email,
      subject: 'Reset Your Password - Ping Pilot',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #2196F3; color: white; padding: 15px; text-align: center;">
            <h1 style="margin: 0;">Password Reset</h1>
          </div>
          <div style="padding: 20px; border: 1px solid #ddd; background-color: #f9f9f9;">
            <h2>Hello${user.name ? ` ${user.name}` : ''},</h2>
            <p>We received a request to reset your password for your Ping Pilot account. Click the button below to reset your password:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" style="display: inline-block; padding: 10px 20px; background-color: #1D4ED8; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
                Reset Password
              </a>
            </div>
            <p>If you didn't request this, please ignore this email. Your password will remain unchanged.</p>
            <p>This link will expire in 24 hours.</p>
            <p>Best regards,<br>Team Ping Pilot</p>
          </div>
        </div>
      `,
    });

    logger.info(`Password reset email sent to ${user.email}: ${info.messageId}`);
    return true;
  } catch (error) {
    logger.error(`Error sending password reset email for ${user.email}: ${error.message}`);
    return false;
  }
};
// Add to services/emailService.js

/**
 * Send support ticket notification to admins
 * @param {Object} ticket - Support ticket object
 * @param {Object} user - User who created the ticket
 * @returns {Boolean} Whether the email was sent
 */
export const sendSupportNotificationEmail = async (ticket, user) => {
  // Get or initialize transporter
  const mailer = initTransporter();
  if (!mailer) {
    logger.warn('Cannot send support notification: email service not configured');
    return false;
  }

  try {
    // Verify SMTP connection
    await mailer.verify();

    // Get from email or use default
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@pingpilot.com';

    // Get admin email from environment or use default
    const adminEmail = process.env.ADMIN_EMAIL || 'support@pingpilot.com';

    // Highlight priority based on user's plan
    let priorityLabel = '';
    if (ticket.userPlan === 'yearly' || ticket.userPlan === 'admin') {
      priorityLabel = ' [PRIORITY]';
    }

    const info = await mailer.sendMail({
      from: `"Ping Pilot Support" <${fromEmail}>`,
      to: adminEmail,
      subject: `New Support Ticket${priorityLabel}: ${ticket.subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #2196F3; color: white; padding: 15px; text-align: center;">
            <h1 style="margin: 0;">New Support Ticket</h1>
          </div>
          <div style="padding: 20px; border: 1px solid #ddd; background-color: #f9f9f9;">
            <p><strong>From:</strong> ${user.email} (${user.displayName || 'Unnamed User'})</p>
            <p><strong>Plan:</strong> ${ticket.userPlan}</p>
            <p><strong>Category:</strong> ${ticket.category}</p>
            <p><strong>Priority:</strong> ${ticket.priority}</p>
            <p><strong>Subject:</strong> ${ticket.subject}</p>
            <p><strong>Message:</strong></p>
            <div style="background-color: #fff; padding: 15px; border-left: 4px solid #2196F3; margin: 10px 0;">
              ${ticket.description.replace(/\n/g, '<br>')}
            </div>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL || 'http://pingpilott.vercel.app'}/admin/support/tickets/${ticket._id}" 
                 style="display: inline-block; padding: 10px 20px; background-color: #1D4ED8; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
                View Ticket
              </a>
            </div>
            <p style="margin-top: 30px; font-size: 12px; color: #777;">
              Automatic notification from Ping Pilot Support System
            </p>
          </div>
        </div>
      `,
    });

    logger.info(`Support notification email sent to admin: ${info.messageId}`);
    return true;
  } catch (error) {
    logger.error(`Error sending support notification email: ${error.message}`);
    return false;
  }
};

/**
 * Send support response notification
 * @param {Object} ticket - Support ticket object
 * @param {Object} user - User to notify
 * @param {Boolean} isToAdmin - Whether notification is to admin
 * @returns {Boolean} Whether the email was sent
 */
export const sendResponseNotificationEmail = async (ticket, user, isToAdmin) => {
  // Get or initialize transporter
  const mailer = initTransporter();
  if (!mailer) {
    logger.warn('Cannot send response notification: email service not configured');
    return false;
  }

  try {
    // Verify SMTP connection
    await mailer.verify();

    // Get from email or use default
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@pingpilot.com';

    // Get recipient email
    const toEmail = isToAdmin
      ? (process.env.ADMIN_EMAIL || 'support@pingpilot.com')
      : user.email;

    // Get latest response
    const latestResponse = ticket.responses[ticket.responses.length - 1];

    const info = await mailer.sendMail({
      from: `"Ping Pilot Support" <${fromEmail}>`,
      to: toEmail,
      subject: `New Response: ${ticket.subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #2196F3; color: white; padding: 15px; text-align: center;">
            <h1 style="margin: 0;">New Support Response</h1>
          </div>
          <div style="padding: 20px; border: l px solid #ddd; background-color: #f9f9f9;">
            <p><strong>Ticket:</strong> ${ticket.subject}</p>
            <p><strong>From:</strong> ${isToAdmin ? user.email : 'Support Team'}</p>
            <p><strong>Message:</strong></p>
            <div style="background-color: #fff; padding: 15px; border-left: 4px solid #2196F3; margin: 10px 0;">
              ${latestResponse.message.replace(/\n/g, '<br>')}
            </div>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL || 'http://pingpilott.vercel.app'}/${isToAdmin ? 'admin/' : ''}support/tickets/${ticket._id}" 
                 style="display: inline-block; padding: 10px 20px; background-color: #1D4ED8; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
                View Ticket
              </a>
            </div>
            <p style="margin-top: 30px; font-size: 12px; color: #777;">
              Automatic notification from Ping Pilot Support System
            </p>
          </div>
        </div>
      `,
    });

    logger.info(`Support response notification email sent to ${toEmail}: ${info.messageId}`);
    return true;
  } catch (error) {
    logger.error(`Error sending support response notification: ${error.message}`);
    return false;
  }
};

export default {
  initTransporter,
  sendAlertEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendResponseNotificationEmail,
  sendSupportNotificationEmail
};
const nodemailer = require("nodemailer");
const twilio = require("twilio");
const logger = require("../utils/logger");

// Email transporter (SendGrid)
const createEmailTransporter = () => {
  return nodemailer.createTransport({
    host: "smtp.sendgrid.net",
    port: 587,
    auth: {
      user: "apikey",
      pass: process.env.SENDGRID_API_KEY,
    },
  });
};

// Send email notification
const sendEmail = async (to, subject, body, html = null) => {
  if (process.env.NODE_ENV === "development") {
    logger.info(`[MOCK EMAIL] To: ${to} | Subject: ${subject}`);
    return `✓ emailed to ${to}`;
  }

  try {
    const transporter = createEmailTransporter();

    await transporter.sendMail({
      from: process.env.SENDGRID_FROM_EMAIL,
      to,
      subject,
      text: body,
      html: html || body.replace(/\n/g, "<br>"),
    });

    logger.info(`✓ Email sent to ${to}`);
    return `✓ emailed to ${to}`;
  } catch (error) {
    logger.error("Failed to send email:", error.message);
    return `✗ failed to email ${to}: ${error.message}`;
  }
};

// SMS client (Twilio)
const createSmsClient = () => {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
};

// Send SMS notification
const sendSMS = async (to, body) => {
  if (process.env.NODE_ENV === "development") {
    logger.info(`[MOCK SMS] To: ${to} | Body: ${body.substring(0, 50)}...`);
    return `✓ messaged ${to}`;
  }

  try {
    const client = createSmsClient();

    const message = await client.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });

    logger.info(`✓ SMS sent to ${to} (SID: ${message.sid})`);
    return `✓ messaged ${to}`;
  } catch (error) {
    logger.error("Failed to send SMS:", error.message);
    return `✗ failed to message ${to}: ${error.message}`;
  }
};

// Format notification content based on event and priority
const formatNotificationContent = (
  event,
  issue,
  priority,
  includeDetails = true,
) => {
  const { issueKey, summary, url } = issue;

  const eventLabels = {
    issue_created: "New issue",
    issue_assigned: "Task assigned",
    issue_updated: "Issue updated",
    issue_commented: "New comment",
    issue_deleted: "Issue deleted",
  };

  const priorityPrefix = priority === "high" ? "🚨 URGENT: " : "";
  const eventLabel = eventLabels[event] || "Issue update";

  let subject = `${priorityPrefix}${eventLabel}: ${issueKey}`;
  let body = `${eventLabel}\n\n${issueKey}: ${summary}`;

  if (includeDetails && url) {
    body += `\n\nView: ${url}`;
  }

  if (priority === "high") {
    body += "\n\n⚠️ This is a HIGH priority item. Please address promptly.";
  }

  return { subject, body };
};

// Check if notification should be sent based on priority config
const shouldNotify = (priority, config) => {
  if (!config?.priorities) return false;

  return (
    {
      high: config.priorities.high,
      medium: config.priorities.medium,
      low: config.priorities.low,
    }[priority] || false
  );
};

module.exports = {
  sendEmail,
  sendSMS,
  formatNotificationContent,
  shouldNotify,
};

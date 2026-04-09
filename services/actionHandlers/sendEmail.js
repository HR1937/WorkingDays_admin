const {
  sendEmail: send,
  formatNotificationContent,
} = require("../../config/notifications");
const logger = require("../../utils/logger");

// Send email notification to assignee
const sendEmail = async ({ to, issue, event, priority }) => {
  try {
    if (!to) {
      return "✗ failed to email: no recipient address";
    }

    const { subject, body } = formatNotificationContent(event, issue, priority);

    const result = await send(to, subject, body);
    return result; // Already formatted as "✓ emailed to X" or error
  } catch (error) {
    logger.error("Email sending failed:", error);
    return `✗ failed to email ${to}: ${error.message}`;
  }
};

module.exports = { sendEmail };

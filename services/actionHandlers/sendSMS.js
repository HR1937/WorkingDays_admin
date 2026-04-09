const {
  sendSMS: send,
  formatNotificationContent,
} = require("../../config/notifications");
const logger = require("../../utils/logger");

// Send SMS notification to assignee
const sendSMS = async ({ to, issue, event, priority }) => {
  try {
    if (!to) {
      return "✗ failed to message: no phone number";
    }

    // SMS needs to be concise
    const { body } = formatNotificationContent(event, issue, priority, false);
    const shortBody = body.substring(0, 160); // SMS limit

    const result = await send(to, shortBody);
    return result; // Already formatted as "✓ messaged X" or error
  } catch (error) {
    logger.error("SMS sending failed:", error);
    return `✗ failed to message ${to}: ${error.message}`;
  }
};

module.exports = { sendSMS };

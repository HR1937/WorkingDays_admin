const Joi = require("joi");

// Common validation schemas
const schemas = {
  // Jira issue payload
  jiraIssue: Joi.object({
    key: Joi.string()
      .pattern(/^[A-Z]+-\d+$/)
      .required(),
    summary: Joi.string().min(1).max(255).required(),
    description: Joi.string().allow("", null),
    priority: Joi.string().valid("low", "medium", "high").default("medium"),
    type: Joi.string().required(),
    status: Joi.string().required(),
    assignee: Joi.object({
      accountId: Joi.string(),
      displayName: Joi.string(),
      emailAddress: Joi.string().email().allow(null),
      slackId: Joi.string().allow(null),
    }).allow(null),
    reporter: Joi.object({
      accountId: Joi.string(),
      displayName: Joi.string(),
      emailAddress: Joi.string().email(),
    }).required(),
    project: Joi.object({
      key: Joi.string().required(),
      name: Joi.string().required(),
    }).required(),
  }),

  // GitHub repo URL
  githubUrl: Joi.string()
    .uri()
    .pattern(/^https:\/\/github\.com\/[^/]+\/[^/]+$/)
    .message(
      "Must be a valid GitHub repository URL (https://github.com/owner/repo)",
    ),

  // Slack channel link
  slackChannel: Joi.string()
    .uri()
    .pattern(/^https:\/\/[^.]+\.slack\.com\/archives\/[A-Z0-9]+$/)
    .message("Must be a valid Slack channel link"),

  // Phone number (E.164 format)
  phoneNumber: Joi.string()
    .pattern(/^\+?[1-9]\d{1,14}$/)
    .message("Must be a valid phone number in E.164 format (+1234567890)"),

  // Email
  email: Joi.string().email().required(),
};

// Validate and return formatted errors
const validate = (data, schema, options = {}) => {
  const { error, value } = schema.validate(data, {
    abortEarly: false, // Return all errors, not just first
    stripUnknown: true, // Remove unknown fields
    ...options,
  });

  if (error) {
    const details = error.details.map((d) => ({
      field: d.path.join("."),
      message: d.message,
      value: d.context?.value,
    }));
    return { error: true, details };
  }

  return { error: false, value };
};

module.exports = { schemas, validate };

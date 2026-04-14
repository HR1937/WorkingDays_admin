/**
 * utils/openai.js
 * Shared OpenAI client + generate() helper used across all services.
 * Model: gpt-4o-mini — best cost/quality ratio, same speed as gemini-2.0-flash.
 *
 * Drop-in scope:
 *   generateText(prompt)  → replaces model.generateContent(prompt)
 *   openaiClient          → raw OpenAI instance for advanced usage
 */
'use strict';

const OpenAI = require('openai');

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = 'gpt-4o-mini';

/**
 * Simple text completion — same API surface as Gemini's generateContent.
 * @param {string} prompt
 * @param {number} [temperature=0.3]
 * @returns {Promise<string>} trimmed text
 */
async function generateText(prompt, temperature = 0.3) {
  const res = await openaiClient.chat.completions.create({
    model: MODEL,
    temperature,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0].message.content.trim();
}

/**
 * Multi-message chat — for conversation flows.
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {number} [temperature=0.4]
 * @returns {Promise<string>} trimmed text
 */
async function chatCompletion(messages, temperature = 0.4) {
  const res = await openaiClient.chat.completions.create({
    model: MODEL,
    temperature,
    messages,
  });
  return res.choices[0].message.content.trim();
}

module.exports = { openaiClient, generateText, chatCompletion, MODEL };

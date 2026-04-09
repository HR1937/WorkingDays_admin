const CryptoJS = require("crypto-js");

// Encryption key (should be 32 chars for AES-256)
const ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ||
  "dev_key_change_in_production_must_be_32_chars!!";

// Encrypt sensitive data (tokens, credentials)
const encrypt = (data) => {
  try {
    return CryptoJS.AES.encrypt(
      JSON.stringify(data),
      ENCRYPTION_KEY,
    ).toString();
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
};

// Decrypt previously encrypted data
const decrypt = (ciphertext) => {
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);

    if (!decrypted) {
      throw new Error("Decryption produced empty result");
    }

    return JSON.parse(decrypted);
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
};

// Hash for comparison (passwords, signatures)
const hash = (data) => {
  return CryptoJS.SHA256(data).toString();
};

// Verify hash matches original
const verifyHash = (data, hashed) => {
  return hash(data) === hashed;
};

module.exports = {
  encrypt,
  decrypt,
  hash,
  verifyHash,
};

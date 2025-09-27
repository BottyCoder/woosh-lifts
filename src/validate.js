// Simple validation utilities for admin endpoints

function createValidationError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}

function requireString(obj, key, options = {}) {
  const value = obj[key];
  
  if (value === undefined || value === null) {
    throw createValidationError(`Missing required field: ${key}`);
  }
  
  const str = String(value).trim();
  
  if (str === '') {
    throw createValidationError(`Field ${key} cannot be empty`);
  }
  
  if (options.max && str.length > options.max) {
    throw createValidationError(`Field ${key} exceeds maximum length of ${options.max}`);
  }
  
  if (options.pattern && !options.pattern.test(str)) {
    throw createValidationError(`Field ${key} has invalid format`);
  }
  
  return str;
}

function optionalString(obj, key, options = {}) {
  const value = obj[key];
  
  if (value === undefined || value === null) {
    return null;
  }
  
  const str = String(value).trim();
  
  if (str === '') {
    return null;
  }
  
  if (options.max && str.length > options.max) {
    throw createValidationError(`Field ${key} exceeds maximum length of ${options.max}`);
  }
  
  if (options.pattern && !options.pattern.test(str)) {
    throw createValidationError(`Field ${key} has invalid format`);
  }
  
  return str;
}

function requireEnum(obj, key, allowedValues) {
  const value = obj[key];
  
  if (value === undefined || value === null) {
    throw createValidationError(`Missing required field: ${key}`);
  }
  
  const str = String(value).trim();
  
  if (!allowedValues.includes(str)) {
    throw createValidationError(`Field ${key} must be one of: ${allowedValues.join(', ')}`);
  }
  
  return str;
}

// Common patterns
const patterns = {
  msisdn: /^[0-9]{10,15}$/,  // 10-15 digits
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
};

module.exports = {
  requireString,
  optionalString,
  requireEnum,
  patterns,
  createValidationError
};

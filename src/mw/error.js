// Global error handling middleware

function errorHandler(err, req, res, next) {
  // Don't handle errors if response already sent
  if (res.headersSent) {
    return next(err);
  }
  
  const isDev = process.env.ENV !== 'prod';
  const level = 'error';
  const route = req.route ? req.route.path : req.path;
  const method = req.method;
  const timestamp = new Date().toISOString();
  
  // Map error types to status codes
  let status = 500;
  let message = 'Internal server error';
  let code = 'INTERNAL_ERROR';
  
  if (err.status) {
    status = err.status;
    message = err.message;
    code = err.code || 'HTTP_ERROR';
  } else if (err.code === 'VALIDATION_ERROR') {
    status = 400;
    message = err.message;
    code = 'VALIDATION_ERROR';
  } else if (err.code === '23505') { // PostgreSQL unique violation
    status = 409;
    message = 'Resource already exists';
    code = 'DUPLICATE_RESOURCE';
  } else if (err.code === '23503') { // PostgreSQL foreign key violation
    status = 404;
    message = 'Referenced resource not found';
    code = 'REFERENCE_ERROR';
  } else if (err.code === '23502') { // PostgreSQL not null violation
    status = 400;
    message = 'Required field missing';
    code = 'MISSING_FIELD';
  }
  
  // Log the error
  const logEntry = {
    level,
    route,
    method,
    status,
    message,
    timestamp,
    ...(isDev && err.stack ? { stack: err.stack } : {})
  };
  
  console.error(JSON.stringify(logEntry));
  
  // Send response
  res.status(status).json({
    ok: false,
    error: {
      code,
      message
    }
  });
}

module.exports = { errorHandler };

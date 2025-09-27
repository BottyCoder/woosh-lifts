// Request logging middleware

function requestLogger(req, res, next) {
  const start = Date.now();
  const timestamp = new Date().toISOString();
  
  // Log when response finishes
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = 'info';
    const route = req.route ? req.route.path : req.path;
    const method = req.method;
    const status = res.statusCode;
    
    const logEntry = {
      level,
      route,
      method,
      status,
      dur_ms: duration,
      ts: timestamp
    };
    
    console.log(JSON.stringify(logEntry));
  });
  
  next();
}

module.exports = { requestLogger };

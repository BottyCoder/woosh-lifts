const { PubSub } = require('@google-cloud/pubsub');
const fetch = require('node-fetch');

const pubsub = new PubSub();
const WA_SENDER_SUB = 'wa-sender-sub';

const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || 'https://wa.woosh.ai';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || '';

// Send message to WhatsApp Bridge
const sendToWhatsAppBridge = async (waMessage) => {
  const payload = {
    to: waMessage.to,
    text: waMessage.text
  };

  console.log('[sender] Sending to Bridge:', waMessage.to, 'text:', waMessage.text.substring(0, 50) + '...');

  const response = await fetch(`${BRIDGE_BASE_URL}/api/messages/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': BRIDGE_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  
  if (!response.ok) {
    console.error('[sender] Bridge error:', response.status, result);
    throw new Error(`Bridge API error: ${response.status} - ${JSON.stringify(result)}`);
  }

  console.log('[sender] Bridge success:', result);
  return result;
};

// Retry logic with exponential backoff
const retryWithBackoff = async (fn, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      console.warn(`[sender] Attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt - 1) * 1000;
      console.log(`[sender] Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Process WhatsApp message
const processWAMessage = async (message) => {
  try {
    const waMessage = JSON.parse(message.data.toString());
    console.log('[sender] Processing WA message:', waMessage.sms_id, 'to:', waMessage.to);

    // Validate message
    if (!waMessage.to || !waMessage.text) {
      throw new Error('Invalid WA message: missing to or text');
    }

    // Ensure E.164 format
    const cleanTo = String(waMessage.to).replace(/\D/g, '');
    if (!cleanTo || cleanTo.length < 10) {
      throw new Error(`Invalid recipient number: ${waMessage.to}`);
    }

    const cleanWAMessage = {
      ...waMessage,
      to: cleanTo
    };

    // Send with retry logic
    const result = await retryWithBackoff(async () => {
      return await sendToWhatsAppBridge(cleanWAMessage);
    });

    console.log('[sender] Successfully sent WA message:', waMessage.sms_id, 'to:', cleanTo, 'wa_id:', result.wa_id);

    return {
      success: true,
      wa_id: result.wa_id,
      to: cleanTo,
      sms_id: waMessage.sms_id,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('[sender] Error processing WA message:', error);
    throw error;
  }
};

// Main sender function
const startSender = async () => {
  console.log('[sender] Starting WhatsApp Sender...');
  
  if (!BRIDGE_API_KEY) {
    console.error('[sender] BRIDGE_API_KEY not set!');
    process.exit(1);
  }

  const subscription = pubsub.subscription(WA_SENDER_SUB);
  
  // Set up message handler
  subscription.on('message', async (message) => {
    try {
      await processWAMessage(message);
      message.ack();
    } catch (error) {
      console.error('[sender] Failed to process message:', error);
      // For now, nack to retry. In production, you might want dead letter queues
      message.nack();
    }
  });

  // Handle errors
  subscription.on('error', (error) => {
    console.error('[sender] Subscription error:', error);
  });

  console.log('[sender] Sender started, listening for WA messages...');
};

// Health check endpoint for Cloud Run
if (require.main === module) {
  const express = require('express');
  const app = express();
  
  app.get('/', (req, res) => {
    res.json({ 
      status: 'sender: ok', 
      timestamp: new Date().toISOString(),
      bridge_url: BRIDGE_BASE_URL
    });
  });

  const port = process.env.PORT || 8080;
  app.listen(port, () => {
    console.log(`[sender] Health server listening on port ${port}`);
    startSender();
  });
}

module.exports = { startSender, processWAMessage, sendToWhatsAppBridge };

const { PubSub } = require('@google-cloud/pubsub');
const fetch = require('node-fetch');

const pubsub = new PubSub();

const WA_OUTBOUND_TOPIC = 'wa-outbound';
const WA_SENDER_SUB = 'wa-sender-sub';

const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || "https://wa.woosh.ai";
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || "";

// Send message to WhatsApp Bridge
const sendToBridge = async (message) => {
  try {
    console.log(`[sender] Sending to Bridge: ${message.id} -> ${message.to}`);
    
    const response = await fetch(`${BRIDGE_BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "X-Api-Key": BRIDGE_API_KEY 
      },
      body: JSON.stringify({
        to: message.to,
        text: message.text
      })
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      console.error(`[sender] Bridge error for ${message.id}:`, response.status, result);
      throw new Error(`Bridge error: ${response.status} - ${JSON.stringify(result)}`);
    }
    
    console.log(`[sender] Successfully sent ${message.id}:`, result);
    return result;
    
  } catch (error) {
    console.error(`[sender] Error sending ${message.id}:`, error);
    throw error;
  }
};

// Process WhatsApp message
const processWAMessage = async (message) => {
  try {
    console.log('[sender] Processing WhatsApp message:', message.id);
    
    const waData = JSON.parse(message.data.toString());
    console.log('[sender] WhatsApp data:', {
      id: waData.id,
      to: waData.to,
      text: waData.text?.substring(0, 50) + '...',
      contact: waData.contact?.lift_name
    });
    
    // Send to WhatsApp Bridge
    const result = await sendToBridge(waData);
    
    console.log(`[sender] Message ${waData.id} sent successfully`);
    return result;
    
  } catch (error) {
    console.error('[sender] Error processing WhatsApp message:', error);
    throw error;
  }
};

// Main function to consume from Pub/Sub
const main = async () => {
  try {
    console.log('[sender] Starting sender service...');
    console.log(`[sender] Subscribing to: ${WA_SENDER_SUB}`);
    
    const subscription = pubsub.subscription(WA_SENDER_SUB);
    
    // Set up message handler
    subscription.on('message', async (message) => {
      try {
        console.log('[sender] Received message:', message.id);
        await processWAMessage(message);
        message.ack();
        console.log('[sender] Message processed and acknowledged');
      } catch (error) {
        console.error('[sender] Error processing message:', error);
        message.nack();
      }
    });
    
    // Set up error handler
    subscription.on('error', (error) => {
      console.error('[sender] Subscription error:', error);
    });
    
    console.log('[sender] Sender service started, waiting for messages...');
    
    // Keep the process alive
    process.on('SIGINT', () => {
      console.log('[sender] Shutting down...');
      subscription.close();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('[sender] Fatal error:', error);
    process.exit(1);
  }
};

// Start the service
main();

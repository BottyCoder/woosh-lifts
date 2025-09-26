const { PubSub } = require('@google-cloud/pubsub');
const { Firestore } = require('@google-cloud/firestore');

const pubsub = new PubSub();
const firestore = new Firestore();

const SMS_INBOUND_TOPIC = 'sms-inbound';
const WA_OUTBOUND_TOPIC = 'wa-outbound';
const SMS_ROUTER_SUB = 'sms-router-sub';

// Message schema for SMS inbound
const normalizeSMSMessage = (rawMessage) => {
  const message = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
  
  return {
    id: message.id || `sms_${Date.now()}`,
    from: String(message.from || message.phoneNumber || '').replace(/\D/g, ''),
    message: message.message || message.text || message.incomingData || '',
    shortcode: message.shortcode || message.sc || message.to || '',
    received_at: message.received_at || new Date().toISOString(),
    raw: message
  };
};

// Lookup contact in Firestore
const lookupContact = async (msisdn) => {
  try {
    const doc = await firestore.collection('contacts').doc(msisdn).get();
    if (doc.exists) {
      const data = doc.data();
      return {
        building: data.building,
        building_code: data.building_code,
        lift_id: data.lift_id,
        recipients: data.wa_destinations || []
      };
    }
    return null;
  } catch (error) {
    console.error('[router] Firestore lookup error:', error);
    return null;
  }
};

// Create WhatsApp message
const createWAMessage = (smsMessage, contact) => {
  const text = `[Lift Alert] ${contact.building} • ${contact.lift_id}
Message: ${smsMessage.message || 'N/A'}
Reply: ✅ Taking / 🆘 Need help`;

  return {
    sms_id: smsMessage.id,
    sms_from: smsMessage.from,
    building: contact.building,
    lift_id: contact.lift_id,
    text,
    timestamp: new Date().toISOString()
  };
};

// Process SMS message
const processSMSMessage = async (message) => {
  try {
    const normalizedMessage = normalizeSMSMessage(message.data.toString());
    console.log('[router] Processing SMS:', normalizedMessage.id, 'from:', normalizedMessage.from);

    // Lookup contact
    const contact = await lookupContact(normalizedMessage.from);
    if (!contact) {
      console.warn('[router] No contact found for MSISDN:', normalizedMessage.from);
      return;
    }

    if (contact.recipients.length === 0) {
      console.warn('[router] No WhatsApp recipients for contact:', normalizedMessage.from);
      return;
    }

    // Create WA message
    const waMessage = createWAMessage(normalizedMessage, contact);

    // Fan out to each recipient
    const waOutboundTopic = pubsub.topic(WA_OUTBOUND_TOPIC);
    
    for (const recipient of contact.recipients) {
      const waPayload = {
        ...waMessage,
        to: recipient,
        recipient_id: recipient
      };

      await waOutboundTopic.publishMessage({
        data: Buffer.from(JSON.stringify(waPayload)),
        attributes: {
          sms_id: normalizedMessage.id,
          building: contact.building,
          lift_id: contact.lift_id,
          recipient: recipient
        }
      });

      console.log('[router] Queued WA message for:', recipient);
    }

    console.log('[router] Successfully processed SMS:', normalizedMessage.id, 'recipients:', contact.recipients.length);

  } catch (error) {
    console.error('[router] Error processing SMS message:', error);
    throw error;
  }
};

// Main router function
const startRouter = async () => {
  console.log('[router] Starting SMS Router...');
  
  const subscription = pubsub.subscription(SMS_ROUTER_SUB);
  
  // Set up message handler
  subscription.on('message', async (message) => {
    try {
      await processSMSMessage(message);
      message.ack();
    } catch (error) {
      console.error('[router] Failed to process message:', error);
      message.nack();
    }
  });

  // Handle errors
  subscription.on('error', (error) => {
    console.error('[router] Subscription error:', error);
  });

  console.log('[router] Router started, listening for SMS messages...');
};

// Health check endpoint for Cloud Run
if (require.main === module) {
  const express = require('express');
  const app = express();
  
  app.get('/', (req, res) => {
    res.json({ status: 'router: ok', timestamp: new Date().toISOString() });
  });

  const port = process.env.PORT || 8080;
  app.listen(port, () => {
    console.log(`[router] Health server listening on port ${port}`);
    startRouter();
  });
}

module.exports = { startRouter, processSMSMessage };

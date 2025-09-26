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
    raw: message.raw || message
  };
};

// Look up contacts in Firestore
const lookupContacts = async (fromNumber) => {
  try {
    console.log(`[router] Looking up contacts for: ${fromNumber}`);
    
    // Query Firestore for contacts matching this number
    const contactsRef = firestore.collection('contacts');
    const snapshot = await contactsRef.where('msisdn', '==', fromNumber).get();
    
    if (snapshot.empty) {
      console.log(`[router] No contacts found for ${fromNumber}`);
      return [];
    }
    
    const contacts = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      contacts.push({
        id: doc.id,
        msisdn: data.msisdn,
        whatsapp: data.whatsapp,
        lift_id: data.lift_id,
        lift_name: data.lift_name
      });
    });
    
    console.log(`[router] Found ${contacts.length} contacts for ${fromNumber}`);
    return contacts;
  } catch (error) {
    console.error('[router] Error looking up contacts:', error);
    return [];
  }
};

// Process SMS message and route to WhatsApp
const processSMSMessage = async (message) => {
  try {
    console.log('[router] Processing SMS message:', message.id);
    
    const smsData = normalizeSMSMessage(message.data.toString());
    console.log('[router] Normalized SMS:', smsData);
    
    // Look up contacts for this number
    const contacts = await lookupContacts(smsData.from);
    
    if (contacts.length === 0) {
      console.log(`[router] No contacts found for ${smsData.from}, skipping`);
      return;
    }
    
    // Create WhatsApp messages for each contact
    for (const contact of contacts) {
      const waMessage = {
        id: `wa_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        to: contact.whatsapp,
        text: `🚨 Lift Alert from ${contact.lift_name || 'Lift'}\n\nFrom: ${smsData.from}\nMessage: ${smsData.message}\nTime: ${smsData.received_at}`,
        contact: contact,
        sms: smsData,
        created_at: new Date().toISOString()
      };
      
      // Publish to wa-outbound topic
      const topic = pubsub.topic(WA_OUTBOUND_TOPIC);
      const messageId = await topic.publishMessage({
        data: Buffer.from(JSON.stringify(waMessage)),
        attributes: {
          id: waMessage.id,
          to: contact.whatsapp,
          lift_id: contact.lift_id || '',
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`[router] Published to wa-outbound: ${messageId} for ${contact.whatsapp}`);
    }
    
  } catch (error) {
    console.error('[router] Error processing SMS message:', error);
    throw error;
  }
};

// Main function to consume from Pub/Sub
const main = async () => {
  try {
    console.log('[router] Starting router service...');
    console.log(`[router] Subscribing to: ${SMS_ROUTER_SUB}`);
    
    const subscription = pubsub.subscription(SMS_ROUTER_SUB);
    
    // Set up message handler
    subscription.on('message', async (message) => {
      try {
        console.log('[router] Received message:', message.id);
        await processSMSMessage(message);
        message.ack();
        console.log('[router] Message processed and acknowledged');
      } catch (error) {
        console.error('[router] Error processing message:', error);
        message.nack();
      }
    });
    
    // Set up error handler
    subscription.on('error', (error) => {
      console.error('[router] Subscription error:', error);
    });
    
    console.log('[router] Router service started, waiting for messages...');
    
    // Keep the process alive
    process.on('SIGINT', () => {
      console.log('[router] Shutting down...');
      subscription.close();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('[router] Fatal error:', error);
    process.exit(1);
  }
};

// Start the service
main();

const { Firestore } = require('@google-cloud/firestore');

const firestore = new Firestore();

// Your contact details
const contactData = {
  building: "Test Building",
  building_code: "TEST", 
  lift_id: "L01",
  wa_destinations: ["278234537125"], // Your WhatsApp number
  region: "ZA",
  created_at: new Date().toISOString()
};

async function setupContact() {
  try {
    console.log('Setting up contact for MSISDN: 278234537125');
    
    // Add contact to Firestore
    await firestore.collection('contacts').doc('278234537125').set(contactData);
    
    console.log('✅ Contact added successfully!');
    console.log('Contact details:', contactData);
    
    // Verify the contact was added
    const doc = await firestore.collection('contacts').doc('278234537125').get();
    if (doc.exists) {
      console.log('✅ Verification: Contact found in Firestore');
      console.log('Data:', doc.data());
    } else {
      console.log('❌ Verification failed: Contact not found');
    }
    
  } catch (error) {
    console.error('❌ Error setting up contact:', error);
  }
}

// Run the setup
setupContact();

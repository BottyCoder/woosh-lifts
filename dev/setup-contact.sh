#!/bin/bash
set -e

# Setup Contact Script
# Usage: ./dev/setup-contact.sh

echo "🔧 Setting up contact for automatic SMS forwarding..."

# Set environment variables
export PROJECT_ID="woosh-lifts-20250924-072759"
export REGION="africa-south1"

# Set project context
gcloud config set project $PROJECT_ID

echo "📝 Adding contact to Firestore..."
node setup-contact.js

echo "✅ Contact setup complete!"
echo "📋 Your number (278234537125) is now configured to receive WhatsApp messages"
echo "📋 Any SMS sent to this number will be forwarded to your WhatsApp"

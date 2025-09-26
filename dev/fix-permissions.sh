#!/bin/bash
# Fix permissions for all deployment scripts

echo "🔧 Fixing script permissions..."

# Make all scripts executable
chmod +x dev/*.sh

# Verify permissions
echo "📋 Script permissions:"
ls -la dev/*.sh

echo "✅ Permissions fixed!"
echo "💡 You can now run:"
echo "  ./dev/deploy-all.sh"
echo "  ./dev/quick-deploy.sh"
echo "  ./dev/check-status.sh"

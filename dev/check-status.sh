#!/bin/bash

# Quick Status Check Script for GCP Cloud Shell
# Shows current git status and deployment info

echo "📊 Woosh Lifts Status Check"
echo "=========================="

# Git status
echo "🔍 Git Status:"
echo "Current branch: $(git branch --show-current)"
echo "Last commit: $(git log -1 --oneline)"
echo "Remote status:"
git status -sb

echo ""
echo "📁 Key Files:"
ls -la server.js router.js sender.js 2>/dev/null || echo "Some files not found"

echo ""
echo "🌐 Current Services:"
echo "Main service:"
gcloud run services describe woosh-lifts --region africa-south1 --format='value(status.url)' 2>/dev/null || echo "Not deployed"

echo "Router service:"
gcloud run services describe woosh-lifts-router --region africa-south1 --format='value(status.url)' 2>/dev/null || echo "Not deployed"

echo "Sender service:"
gcloud run services describe woosh-lifts-sender --region africa-south1 --format='value(status.url)' 2>/dev/null || echo "Not deployed"

echo ""
echo "💡 Quick Commands:"
echo "  ./dev/gcp-robust-pull.sh  - Pull latest changes"
echo "  ./dev/deploy-with-pull.sh - Full deployment with pull"
echo "  ./dev/smoke.sh           - Run tests"

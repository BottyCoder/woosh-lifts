#!/bin/bash
set -e

# Robust Git Pull Script for GCP Cloud Shell
# This script ensures you get the latest changes and provides detailed feedback

echo "🔄 Starting robust git pull process on GCP Cloud Shell..."

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ Error: Not in a git repository"
    exit 1
fi

# Store current branch
CURRENT_BRANCH=$(git branch --show-current)
echo "📍 Current branch: $CURRENT_BRANCH"

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "⚠️  Warning: You have uncommitted changes"
    echo "📋 Uncommitted files:"
    git status --porcelain
    echo ""
    read -p "Do you want to stash changes and continue? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "💾 Stashing changes..."
        git stash push -m "Auto-stash before robust pull $(date)"
    else
        echo "❌ Aborting pull due to uncommitted changes"
        exit 1
    fi
fi

# Fetch latest changes from remote with verbose output
echo "🌐 Fetching latest changes from remote..."
git fetch origin --all --prune --verbose

# Check if remote branch exists
if ! git show-ref --verify --quiet refs/remotes/origin/$CURRENT_BRANCH; then
    echo "❌ Error: Remote branch origin/$CURRENT_BRANCH does not exist"
    echo "Available remote branches:"
    git branch -r
    exit 1
fi

# Get commit hashes for comparison
LOCAL_COMMIT=$(git rev-parse HEAD)
REMOTE_COMMIT=$(git rev-parse origin/$CURRENT_BRANCH)

echo "📊 Commit comparison:"
echo "   Local:  $LOCAL_COMMIT"
echo "   Remote: $REMOTE_COMMIT"

# Check if we're behind
if [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ]; then
    echo "✅ Already up to date with origin/$CURRENT_BRANCH"
else
    echo "🔄 Pulling latest changes..."
    
    # Show what's new
    echo "📋 New commits since last pull:"
    git log --oneline $LOCAL_COMMIT..origin/$CURRENT_BRANCH
    
    # Perform the pull with verbose output
    echo "🔄 Executing git pull with verbose output..."
    git pull origin $CURRENT_BRANCH --verbose
    
    if [ $? -eq 0 ]; then
        echo "✅ Successfully pulled latest changes"
        
        # Show updated files
        echo "📁 Files changed in this pull:"
        git diff --name-only $LOCAL_COMMIT..HEAD
        
        # Check for any merge conflicts
        if git diff --name-only --diff-filter=U | grep -q .; then
            echo "⚠️  Merge conflicts detected:"
            git diff --name-only --diff-filter=U
            echo "Please resolve conflicts manually"
            exit 1
        fi
        
    else
        echo "❌ Pull failed"
        exit 1
    fi
fi

# Verify the pull was successful
NEW_COMMIT=$(git rev-parse HEAD)
if [ "$NEW_COMMIT" = "$REMOTE_COMMIT" ]; then
    echo "✅ Verification successful: Now at latest commit $NEW_COMMIT"
else
    echo "❌ Verification failed: Expected $REMOTE_COMMIT, got $NEW_COMMIT"
    exit 1
fi

# Show current status
echo "📊 Current repository status:"
git status --short

# Show recent commits
echo "📋 Recent commits:"
git log --oneline -5

# Show file timestamps to verify we have the latest
echo "📁 Key files and their modification times:"
ls -la server.js router.js sender.js 2>/dev/null || echo "Some files not found"

echo "🎉 Robust pull completed successfully!"
echo "💡 You can now proceed with deployment using:"
echo "   ./dev/deploy.sh"
echo "   ./dev/deploy-router.sh"
echo "   ./dev/deploy-sender.sh"

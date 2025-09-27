# Robust Git Pull Script for woosh-lifts (PowerShell)
# This script ensures you get the latest changes and provides detailed feedback

Write-Host "🔄 Starting robust git pull process..." -ForegroundColor Cyan

# Check if we're in a git repository
try {
    $gitDir = git rev-parse --git-dir 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Not in a git repository"
    }
} catch {
    Write-Host "❌ Error: Not in a git repository" -ForegroundColor Red
    exit 1
}

# Store current branch
$currentBranch = git branch --show-current
Write-Host "📍 Current branch: $currentBranch" -ForegroundColor Yellow

# Check for uncommitted changes
$uncommittedChanges = git diff-index --quiet HEAD -- 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  Warning: You have uncommitted changes" -ForegroundColor Yellow
    Write-Host "📋 Uncommitted files:" -ForegroundColor Yellow
    git status --porcelain
    
    $response = Read-Host "Do you want to stash changes and continue? (y/N)"
    if ($response -match "^[Yy]$") {
        Write-Host "💾 Stashing changes..." -ForegroundColor Blue
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        git stash push -m "Auto-stash before robust pull $timestamp"
    } else {
        Write-Host "❌ Aborting pull due to uncommitted changes" -ForegroundColor Red
        exit 1
    }
}

# Fetch latest changes from remote
Write-Host "🌐 Fetching latest changes from remote..." -ForegroundColor Cyan
git fetch origin --all --prune

# Check if remote branch exists
$remoteBranch = "origin/$currentBranch"
$remoteExists = git show-ref --verify "refs/remotes/$remoteBranch" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Error: Remote branch $remoteBranch does not exist" -ForegroundColor Red
    Write-Host "Available remote branches:" -ForegroundColor Yellow
    git branch -r
    exit 1
}

# Get commit hashes for comparison
$localCommit = git rev-parse HEAD
$remoteCommit = git rev-parse $remoteBranch

Write-Host "📊 Commit comparison:" -ForegroundColor Cyan
Write-Host "   Local:  $localCommit" -ForegroundColor Gray
Write-Host "   Remote: $remoteCommit" -ForegroundColor Gray

# Check if we're behind
if ($localCommit -eq $remoteCommit) {
    Write-Host "✅ Already up to date with $remoteBranch" -ForegroundColor Green
} else {
    Write-Host "🔄 Pulling latest changes..." -ForegroundColor Cyan
    
    # Show what's new
    Write-Host "📋 New commits since last pull:" -ForegroundColor Yellow
    git log --oneline "$localCommit..$remoteBranch"
    
    # Perform the pull
    Write-Host "🔄 Executing git pull..." -ForegroundColor Cyan
    git pull origin $currentBranch
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Successfully pulled latest changes" -ForegroundColor Green
        
        # Show updated files
        Write-Host "📁 Files changed in this pull:" -ForegroundColor Yellow
        git diff --name-only "$localCommit..HEAD"
        
        # Check for any merge conflicts
        $conflicts = git diff --name-only --diff-filter=U
        if ($conflicts) {
            Write-Host "⚠️  Merge conflicts detected:" -ForegroundColor Red
            Write-Host $conflicts -ForegroundColor Red
            Write-Host "Please resolve conflicts manually" -ForegroundColor Red
            exit 1
        }
        
    } else {
        Write-Host "❌ Pull failed" -ForegroundColor Red
        exit 1
    }
}

# Verify the pull was successful
$newCommit = git rev-parse HEAD
if ($newCommit -eq $remoteCommit) {
    Write-Host "✅ Verification successful: Now at latest commit $newCommit" -ForegroundColor Green
} else {
    Write-Host "❌ Verification failed: Expected $remoteCommit, got $newCommit" -ForegroundColor Red
    exit 1
}

# Show current status
Write-Host "📊 Current repository status:" -ForegroundColor Cyan
git status --short

# Show recent commits
Write-Host "📋 Recent commits:" -ForegroundColor Yellow
git log --oneline -5

Write-Host "🎉 Robust pull completed successfully!" -ForegroundColor Green

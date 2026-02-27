#!/bin/bash
set -e

# Release script for TPS plugins
# Usage: ./scripts/release.sh v1.2.3

VERSION=$1
if [ -z "$VERSION" ]; then
    echo "❌ Usage: $0 v1.2.3"
    exit 1
fi

echo "🚀 Starting release $VERSION"

# Validate version format
if [[ ! $VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "❌ Version must follow semantic versioning: v1.2.3"
    exit 1
fi

# Ensure we're on develop
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "develop" ]; then
    echo "❌ Switch to develop branch first"
    exit 1
fi

# Pull latest changes
echo "📥 Pulling latest develop branch..."
git pull origin develop

# Create release branch
RELEASE_BRANCH="release/$VERSION"
echo "🌿 Creating release branch: $RELEASE_BRANCH"
git checkout -b $RELEASE_BRANCH develop

# Update version in manifest.json
echo "📝 Updating version in manifest.json..."
sed -i.tmp "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" manifest.json
rm -f manifest.json.tmp

# Update package.json version (remove v prefix)
PKG_VERSION=${VERSION#v}
sed -i.tmp "s/\"version\": \".*\"/\"version\": \"$PKG_VERSION\"/" package.json
rm -f package.json.tmp

# Commit version updates
echo "💾 Committing version updates..."
git add manifest.json package.json
git commit -m "chore: Bump version to $VERSION"

# Merge to main
echo "🔀 Merging to main branch..."
git checkout main
git pull origin main
git merge --no-ff $RELEASE_BRANCH -m "chore: Release $VERSION"

# Tag the release
echo "🏷️  Tagging release $VERSION..."
git tag -a $VERSION -m "Release $VERSION"

# Merge back to develop
echo "🔀 Merging back to develop..."
git checkout develop
git pull origin develop
git merge --no-ff $RELEASE_BRANCH -m "chore: Merge $VERSION back to develop"

# Push everything
echo "📤 Pushing changes..."
git push origin main
git push origin develop
git push origin $VERSION

# Delete release branch
echo "🗑️  Cleaning up release branch..."
git branch -d $RELEASE_BRANCH
git push origin --delete $RELEASE_BRANCH

echo "✅ Release $VERSION completed successfully!"
echo "📋 Check GitHub Actions for build and release deployment"
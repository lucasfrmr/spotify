#!/bin/bash

# Set your Git configuration (Update with your details)
GIT_USERNAME="Lucasfrmr"
GIT_EMAIL="lucasfrmr@gmail.com"
REPO_DESCRIPTION="My new project"  # Replace with your repository description

REPO_NAME=$(basename "$(pwd)")
# Navigate to your project directory (Update with your project path)
cd /usr/share/nginx/html/spotify

# Initialize Git and set configurations
git init
git config user.name "$GIT_USERNAME"
git config user.email "$GIT_EMAIL"

# Create a .gitignore file and exclude node_modules
echo "node_modules/" >> .gitignore

# Add all files to the repository and commit them
git add .
git commit -m "Initial commit"

# Create a new repository on GitHub
gh repo create $REPO_NAME --public --description "$REPO_DESCRIPTION" --source=.

# Push to GitHub
git push -u origin master

echo "Repository successfully created and pushed to GitHub."

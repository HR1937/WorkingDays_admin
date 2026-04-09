# Firebase Setup Guide

## 1. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Click "Add project" → Enter project name → Continue
3. Disable Google Analytics (optional) → Create project

## 2. Enable Firestore Database

1. In project dashboard, click "Build" → "Firestore Database"
2. Click "Create database"
3. Start in **test mode** for development (we'll update rules later)
4. Choose location closest to your users

## 3. Generate Service Account Key

1. Go to Project Settings ⚙️ → "Service accounts" tab
2. Click "Generate new private key"
3. Download the JSON file → Save as `service-account-key.json` in project root
4. ⚠️ **NEVER commit this file to version control**

## 4. Set Environment Variables

Add these to your `.env` file:

```bash
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_KEY\n-----END PRIVATE KEY-----\n"
```

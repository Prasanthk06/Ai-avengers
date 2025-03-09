# WhatsApp Bot Application

This is a WhatsApp Bot application with MongoDB integration, file storage capabilities, and an admin dashboard.

## Railway Deployment Guide

### Setup

1. **Fork or clone this repository**

2. **Create a Railway account** (if you don't have one): [Railway](https://railway.app/)

3. **Create a new project in Railway** and link your repository

### Environment Variables

Set the following environment variables in Railway's dashboard:

```
MONGODB_URI=your_mongodb_connection_string
GOOGLE_CLOUD_PROJECT_ID=your_google_cloud_project_id
GOOGLE_CLOUD_PRIVATE_KEY=your_google_cloud_private_key
GOOGLE_CLOUD_CLIENT_EMAIL=your_google_cloud_client_email
GOOGLE_CLOUD_BUCKET_NAME=your_google_cloud_bucket_name
GEMINI_API_KEY=your_gemini_api_key
SESSION_SECRET=your_session_secret
EMAIL=your_email@example.com
EMAIL_PASSWORD=your_email_app_password
NODE_ENV=production
```

### Deployment Steps

1. **Deploy your application** from Railway dashboard

2. **Initialize WhatsApp** after deployment:
   - Run `node initWhatsApp.js` from the Railway terminal
   - Access the provided URL to scan the QR code
   - You have 10 minutes to scan the QR code before the script exits

### After Deployment

1. **Verify the connection** by checking Railway logs

2. **Access admin dashboard** at your deployment URL

### WhatsApp Session Management

Since Railway uses ephemeral storage, you'll need to re-authenticate WhatsApp after each deployment. Follow these steps:

1. Go to your Railway dashboard
2. Open the shell for your project
3. Run: `node initWhatsApp.js`
4. Scan the QR code when prompted
5. Wait for the "Client is ready!" message

### Troubleshooting

If you encounter issues:

1. **Check logs** in Railway dashboard
2. **Rebuild from scratch** if the session gets corrupted
3. **Run resetWhatsApp.js** to clear session data: `node resetWhatsApp.js`

### Maintenance

To prevent your application from sleeping:

1. Set up a ping service (like UptimeRobot) to keep your app active
2. Configure it to ping your app's URL every 5-10 minutes

## Local Development

1. Clone the repository
2. Create a `.env` file with all required environment variables
3. Run `npm install`
4. Run `node server.js`
5. Access the admin panel at http://localhost:3000 
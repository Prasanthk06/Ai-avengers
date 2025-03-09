/**
 * WhatsApp Initialization Utility for Railway Deployment
 * 
 * This script can be used after deployment to generate a fresh QR code
 * and help set up the WhatsApp connection in ephemeral environments.
 */

const client = require('./bot');
const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Ensure QR directory exists
const qrDir = path.join(__dirname, 'public');
if (!fs.existsSync(qrDir)) {
  fs.mkdirSync(qrDir, { recursive: true });
}

// QR Code route - publicly accessible for quick scanning
app.get('/qr', (req, res) => {
  const qrPath = path.join(__dirname, 'public', 'latest-qr.png');
  
  if (fs.existsSync(qrPath)) {
    // Get file age in minutes
    const stats = fs.statSync(qrPath);
    const fileAgeMinutes = (new Date() - stats.mtime) / (1000 * 60);
    
    if (fileAgeMinutes < 5) {
      // QR code is fresh enough, serve it
      res.sendFile(qrPath);
    } else {
      // QR code is too old
      res.status(404).send('QR code expired. Restart the server to generate a new one.');
    }
  } else {
    res.status(404).send('QR code not generated yet. Restart the server or wait for it to generate.');
  }
});

// Status route
app.get('/status', (req, res) => {
  res.json({
    authenticated: client.info ? true : false,
    info: client.info,
    qrAvailable: fs.existsSync(path.join(__dirname, 'public', 'latest-qr.png'))
  });
});

// Force initialize the client
client.initialize().catch(err => {
  console.error('Failed to initialize WhatsApp client:', err);
});

// Listen on a different port than the main app
const PORT = process.env.INIT_PORT || 3030;
app.listen(PORT, () => {
  console.log(`WhatsApp initialization server running on port ${PORT}`);
  console.log(`Access the QR code at: http://localhost:${PORT}/qr`);
  console.log(`Check connection status at: http://localhost:${PORT}/status`);
});

// Exit after 10 minutes (enough time to scan QR in most cases)
setTimeout(() => {
  console.log('Initialization utility shutting down...');
  process.exit(0);
}, 10 * 60 * 1000); 
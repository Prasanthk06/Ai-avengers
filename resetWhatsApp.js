const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Path to WhatsApp auth folder
const authPath = path.join(process.cwd(), '.wwebjs_auth');
const publicPath = path.join(process.cwd(), 'public');

// Function to remove a directory recursively
function deleteFolderRecursive(folderPath) {
    if (fs.existsSync(folderPath)) {
        fs.readdirSync(folderPath).forEach((file) => {
            const curPath = path.join(folderPath, file);
            if (fs.lstatSync(curPath).isDirectory()) {
                // Recurse
                deleteFolderRecursive(curPath);
            } else {
                // Delete file
                fs.unlinkSync(curPath);
                console.log(`Deleted file: ${curPath}`);
            }
        });
        
        // Delete folder itself
        fs.rmdirSync(folderPath);
        console.log(`Deleted folder: ${folderPath}`);
    }
}

// Remove the QR code file if it exists
if (fs.existsSync(path.join(publicPath, 'latest-qr.png'))) {
    fs.unlinkSync(path.join(publicPath, 'latest-qr.png'));
    console.log('Deleted QR code file');
}

// Remove the auth folder
console.log('Deleting WhatsApp session data...');
deleteFolderRecursive(authPath);
console.log('WhatsApp session data deleted');

// Clear global variables
console.log('To complete the reset:');
console.log('1. Stop the server');
console.log('2. Start it again with: node server.js');
console.log('3. Login to the admin panel and use the "Regenerate QR Code" button'); 
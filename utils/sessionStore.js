const fs = require('fs');

const SESSION_FILE = './whatsapp-sessions/session.json';

const saveSession = (session) => {
    fs.writeFile(SESSION_FILE, JSON.stringify(session), (err) => {
        if (err) console.log(err);
    });
};

const getSession = () => {
    if (fs.existsSync(SESSION_FILE)) {
        return JSON.parse(fs.readFileSync(SESSION_FILE));
    }
    return null;
};

module.exports = { saveSession, getSession };

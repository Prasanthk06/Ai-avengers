const { connectDB, User } = require('./database');
require('dotenv').config();

async function makeUserAdmin(email) {
    try {
        // Connect to the database
        await connectDB();
        
        // Find the user with the specified email
        const user = await User.findOne({ email });
        
        if (!user) {
            console.log(`User with email ${email} not found.`);
            process.exit(1);
        }
        
        // Update the user to make them an admin
        await User.updateOne({ email }, { isAdmin: true });
        
        console.log(`User ${user.name} (${email}) has been made an admin successfully!`);
        
        process.exit(0);
    } catch (error) {
        console.error('Error making user admin:', error);
        process.exit(1);
    }
}

// Email address to make admin
const userEmail = 'krishna6264012110@gmail.com';

makeUserAdmin(userEmail); 
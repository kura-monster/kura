const mongoose = require('mongoose');

async function connectDB() {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/discord_buy_bot';
    if (!/^mongodb(?:\+srv)?:\/\//i.test(MONGODB_URI)) {
        console.error('Invalid MONGODB_URI. Must start with mongodb:// or mongodb+srv://');
        process.exit(1);
    }
    try {
        await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log('MongoDB connected successfully');
    } catch (err) {
        console.error('MongoDB connection error:', err);
        process.exit(1);
    }
}

module.exports = { connectDB };

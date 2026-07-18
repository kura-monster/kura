const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    money: { type: Number, default: 5000 },
    autoJoinEvent: { type: Boolean, default: false },
    avatar: { type: String, default: null }, // Discord アバター URL
    roles: { type: Array, default: [] }    // Discord ロール情報
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);

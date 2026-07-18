const mongoose = require('mongoose');

const poolSchema = new mongoose.Schema({
    _id: { type: String, default: 'global_pool' },
    amount: { type: Number, default: 0 }
});

module.exports = mongoose.models.Pool || mongoose.model('Pool', poolSchema);

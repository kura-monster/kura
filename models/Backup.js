const mongoose = require('mongoose');

const webauthnCredentialSchema = new mongoose.Schema({
    credentialID: { type: String, required: true },
    credentialPublicKey: { type: Buffer, required: true },
    counter: { type: Number, default: 0 },
    transports: { type: [String], default: [] }
}, { _id: false });

const backupSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    roles: { type: [String], default: [] },
    username: { type: String, default: '' },
    setupToken: { type: String, required: true, unique: true },
    setupTokenUsed: { type: Boolean, default: false },
    setupTokenExpires: { type: Date },
    recoverSessionToken: { type: String },
    recoverSessionExpires: { type: Date },
    used: { type: Boolean, default: false },
    webauthnCredentials: { type: [webauthnCredentialSchema], default: [] },
    passwordHash: { type: String },
    passwordFingerprint: { type: String },
    pendingChallenge: { type: String },
    pendingChallengeExpires: { type: Date }
});

module.exports = mongoose.models.Backup || mongoose.model('Backup', backupSchema);

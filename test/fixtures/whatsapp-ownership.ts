import type { WhatsAppOwnership, WhatsAppEnvironment } from '../../src/services/whatsapp-ownership.js';
// Synthetic server proof for the existing ingress regression suite only.
// Real Graph verification and credential binding are exercised separately.
export const fixtureOwnership=(environment:WhatsAppEnvironment='META_TEST'):WhatsAppOwnership=>({
 async verify(){return {environment,credentialDigest:'a'.repeat(64),expiresAt:new Date('2100-01-01T00:00:00Z')};},
 async current(_connection,proof){return proof.environment===environment && proof.credentialDigest==='a'.repeat(64);}
});

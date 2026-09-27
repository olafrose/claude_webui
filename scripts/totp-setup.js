// Generates a TOTP secret for the optional second login factor.
import crypto from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let bits = '';
for (const b of crypto.randomBytes(20)) bits += b.toString(2).padStart(8, '0');
let secret = '';
for (let i = 0; i < bits.length; i += 5) secret += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];

const uri = `otpauth://totp/Claude%20Remote?secret=${secret}&issuer=Claude%20Remote&algorithm=SHA1&digits=6&period=30`;
console.log('Add this line to your .env:\n');
console.log(`TOTP_SECRET=${secret}\n`);
console.log('Then add it to your authenticator app, either by entering the secret manually');
console.log('or by turning this URI into a QR code (e.g. offline with `qrencode -t ansiutf8`):\n');
console.log(uri);

// Give an existing account access to the Admin screen (approve permits, handle refunds).
// Usage:  npm run make-admin -- you@example.com          (add)
//         npm run make-admin -- you@example.com --remove (remove)
// Run it on the server, with the same DATA_DIR as the app. The person must sign up in the app first.
const { one, run } = require('../src/db');

const email = String(process.argv[2] || '').trim().toLowerCase();
const remove = process.argv.includes('--remove');
if (!email || email.startsWith('-')) {
  console.error('Usage: npm run make-admin -- you@example.com [--remove]');
  process.exit(1);
}
const user = one('SELECT id, name, is_admin FROM users WHERE email = ?', email);
if (!user) {
  console.error(`No account for ${email}. Sign up in the app with that email first, then run this again.`);
  process.exit(1);
}
run('UPDATE users SET is_admin = ? WHERE id = ?', remove ? 0 : 1, user.id);
console.log(`${user.name} <${email}> ${remove ? 'is no longer an admin' : 'is now an admin'}.`);

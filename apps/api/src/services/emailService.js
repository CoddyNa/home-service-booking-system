const nodemailer = require('nodemailer');

function configured() {
  return Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM && (!process.env.SMTP_USER || process.env.SMTP_PASSWORD));
}

async function sendPasswordReset(email, token) {
  if (!configured()) return false;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  });
  const baseUrl = process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
  const resetUrl = new URL('/', baseUrl);
  resetUrl.hash = new URLSearchParams({ token }).toString();
  await transport.sendMail({
    from: process.env.MAIL_FROM,
    to: email,
    subject: 'Reset your password',
    text: `Use this link to reset your password. It expires in 30 minutes:\n\n${resetUrl.toString()}\n\nIf you did not request this, ignore this message.`,
  });
  return true;
}

module.exports = { sendPasswordReset, configured };

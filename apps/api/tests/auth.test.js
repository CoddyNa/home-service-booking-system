// apps/api/tests/auth.test.js
const request = require('supertest');
const { authenticator } = require('otplib');
const app = require('../src/app');
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

// Helper to generate a random email each run
function randomEmail() {
  return `user${Date.now()}@example.com`;
}

describe('Authentication flow', () => {
  let csrfToken = '';
  const agent = request.agent(app); // persist cookies

  beforeAll(async () => {
    // Get CSRF token
    const res = await agent.get('/api/csrf-token');
    csrfToken = res.body.csrfToken;
  });

  test('State-changing requests reject missing CSRF tokens', async () => {
    const res = await request(app).post('/api/auth/register').send({ username: 'blocked', email: randomEmail(), password: 'Password123!' });
    expect(res.status).toBe(403);
  });

  test('Register a new user', async () => {
    const email = randomEmail();
    const res = await agent
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .set('X-CSRF-Token', csrfToken)
      .send({ username: 'testuser', email, password: 'Password123!' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('userId');
  });

  test('Login with registered user', async () => {
    const email = randomEmail();
    // Register first
    await agent
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .set('X-CSRF-Token', csrfToken)
      .send({ username: 'loginuser', email, password: 'Password123!' });

    // Get fresh CSRF token (session may have changed)
    const tokenRes = await agent.get('/api/csrf-token');
    const freshToken = tokenRes.body.csrfToken;

    const loginRes = await agent
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('X-CSRF-Token', freshToken)
      .send({ email, password: 'Password123!' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body).toHaveProperty('message', 'Logged in');
  });

  test('Password reset tokens are one-time and allow a password update', async () => {
    const email = randomEmail();
    const agent = request.agent(app);
    let csrf = (await agent.get('/api/csrf-token')).body.csrfToken;
    await agent.post('/api/auth/register').set('X-CSRF-Token', csrf).send({ username: 'resetuser', email, password: 'Password123!' }).expect(201);
    csrf = (await agent.get('/api/csrf-token')).body.csrfToken;
    const reset = await agent.post('/api/auth/password-reset/request').set('X-CSRF-Token', csrf).send({ email }).expect(200);
    expect(reset.body.resetToken).toBeTruthy();
    const newPassword = 'BetterPassword123!';
    await agent.post('/api/auth/password-reset/confirm').set('X-CSRF-Token', csrf).send({ token: reset.body.resetToken, password: newPassword }).expect(200);
    await agent.post('/api/auth/password-reset/confirm').set('X-CSRF-Token', csrf).send({ token: reset.body.resetToken, password: newPassword }).expect(400);
    const login = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email, password: newPassword }).expect(200);
    expect(login.body.message).toBe('Logged in');
  });

  test('TOTP setup enables 2FA and requires a code at login', async () => {
    const email = randomEmail();
    const agent = request.agent(app);
    let csrf = (await agent.get('/api/csrf-token')).body.csrfToken;
    await agent.post('/api/auth/register').set('X-CSRF-Token', csrf).send({ username: 'totpuser', email, password: 'Password123!' }).expect(201);
    csrf = (await agent.get('/api/csrf-token')).body.csrfToken;
    const firstLogin = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email, password: 'Password123!' }).expect(200);
    csrf = firstLogin.body.csrfToken;
    const setup = await agent.post('/api/auth/2fa/setup').set('X-CSRF-Token', csrf).expect(200);
    expect(setup.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    await agent.post('/api/auth/2fa/verify').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(setup.body.secret) }).expect(200);

    const secondAgent = request.agent(app);
    csrf = (await secondAgent.get('/api/csrf-token')).body.csrfToken;
    const challenge = await secondAgent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email, password: 'Password123!' }).expect(200);
    expect(challenge.body.requires2FA).toBe(true);
    const verified = await secondAgent.post('/api/auth/2fa/verify').set('X-CSRF-Token', csrf).send({ code: authenticator.generate(setup.body.secret) }).expect(200);
    expect(verified.body.message).toBe('Logged in');
    expect(verified.body.csrfToken).toBeTruthy();
  });
});

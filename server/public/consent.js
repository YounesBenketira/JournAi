import { deriveCredentials } from '/credential.js';
const form = document.querySelector('#consent');
const deviceButton = document.querySelector('#use-app');
const browserProof = () => ({ requestId: form.dataset.request, csrf: form.dataset.csrf });
async function deviceRequest(path) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(browserProof()) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Connection failed.');
  return result;
}
async function waitForApproval() {
  try {
    const result = await deviceRequest('/oauth/device/status');
    if (result.redirect) window.location.assign(result.redirect);
    else setTimeout(waitForApproval, 3000);
  } catch (reason) {
    document.querySelector('#device-status').textContent = reason.message;
    deviceButton.disabled = false;
  }
}
deviceButton.addEventListener('click', async () => {
  deviceButton.disabled = true;
  try {
    const result = await deviceRequest('/oauth/device/start');
    document.querySelector('#error').textContent = '';
    document.querySelector('#device-consent').hidden = false;
    document.querySelector('#device-code').value = result.code;
    document.querySelector('#device-status').textContent = 'Waiting for approval in JournAi...';
    void waitForApproval();
  } catch (reason) {
    document.querySelector('#error').textContent = reason.message;
    deviceButton.disabled = false;
  }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  const error = document.querySelector('#error');
  error.textContent = '';
  try {
    const email = document.querySelector('#email').value.trim().toLowerCase();
    const password = document.querySelector('#password');
    const { credential } = await deriveCredentials(email, password.value);
    password.value = '';
    const response = await fetch('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, credential, requestId: form.dataset.request, csrf: form.dataset.csrf }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Connection failed.');
    window.location.assign(result.redirect);
  } catch (reason) {
    error.textContent = reason.message;
  } finally {
    button.disabled = false;
  }
});

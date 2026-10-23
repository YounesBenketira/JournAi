import { deriveCredentials } from '/credential.js';
const form = document.querySelector('#consent');
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

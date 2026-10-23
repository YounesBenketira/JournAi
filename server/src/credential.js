/**
 * This module also runs in the browser; the server receives only the login proof.
 */
export async function deriveCredentials(email, password) {
  const bytes = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', bytes.encode(password), 'PBKDF2', false, ['deriveBits']);
  const root = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes.encode(`journai:account:v1:${email.trim().toLowerCase()}`), iterations: 600000 }, material, 256);
  const key = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
  const derive = label => crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: bytes.encode(label) }, key, 256);
  const auth = new Uint8Array(await derive('journai:login:v1'));
  const journal = new Uint8Array(await derive('journai:journal:v1'));
  return {
    credential: Array.from(auth, n => n.toString(16).padStart(2, '0')).join(''),
    journalKey: btoa(String.fromCharCode(...journal)),
  };
}

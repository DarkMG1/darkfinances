function b64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromB64url(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(base64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
}

async function signIn() {
  const btn = document.getElementById('signInBtn');
  btn.disabled = true;
  setStatus('Waiting for passkey...');
  try {
    const optRes = await fetch('/auth/login/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const options = await optRes.json();
    if (!optRes.ok) throw new Error(options.error || 'Could not start authentication');
    options.challenge = fromB64url(options.challenge);
    if (options.allowCredentials) {
      options.allowCredentials = options.allowCredentials.map((c) => ({ ...c, id: fromB64url(c.id) }));
    }
    const cred = await navigator.credentials.get({ publicKey: options });
    const payload = {
      id: cred.id,
      rawId: b64url(cred.rawId),
      type: cred.type,
      response: {
        authenticatorData: b64url(cred.response.authenticatorData),
        clientDataJSON: b64url(cred.response.clientDataJSON),
        signature: b64url(cred.response.signature),
        userHandle: cred.response.userHandle ? b64url(cred.response.userHandle) : null,
      },
    };
    const verRes = await fetch('/auth/login/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await verRes.json();
    if (result.ok) {
      setStatus('Signing in...', 'success');
      window.location.href = '/';
    } else {
      setStatus(result.error || 'Authentication failed', 'error');
    }
  } catch (e) {
    if (e.name === 'NotAllowedError') setStatus('Cancelled', '');
    else setStatus(e.message, 'error');
  }
  btn.disabled = false;
}

async function register() {
  const btn = document.getElementById('signInBtn');
  btn.disabled = true;
  setStatus('Setting up passkey...');
  try {
    const code = window.prompt('Enter the one-time enrollment code');
    if (!code) {
      setStatus('Enrollment cancelled');
      btn.disabled = false;
      return;
    }
    const authRes = await fetch('/auth/enroll/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const authResult = await authRes.json();
    if (!authRes.ok) throw new Error(authResult.error || 'Enrollment authorization failed');

    const optRes = await fetch('/auth/register/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const options = await optRes.json();
    if (!optRes.ok) throw new Error(options.error || 'Could not start registration');
    options.challenge = fromB64url(options.challenge);
    options.user.id = fromB64url(options.user.id);
    if (options.excludeCredentials) {
      options.excludeCredentials = options.excludeCredentials.map((c) => ({ ...c, id: fromB64url(c.id) }));
    }
    const cred = await navigator.credentials.create({ publicKey: options });
    const payload = {
      id: cred.id,
      rawId: b64url(cred.rawId),
      type: cred.type,
      response: {
        attestationObject: b64url(cred.response.attestationObject),
        clientDataJSON: b64url(cred.response.clientDataJSON),
        transports: cred.response.getTransports ? cred.response.getTransports() : [],
      },
    };
    const verRes = await fetch('/auth/register/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await verRes.json();
    if (result.ok) {
      setStatus('Passkey registered!', 'success');
      window.location.href = '/';
    } else {
      setStatus(result.error || 'Registration failed', 'error');
    }
  } catch (e) {
    if (e.name === 'NotAllowedError') setStatus('Cancelled', '');
    else setStatus(e.message, 'error');
  }
  btn.disabled = false;
}

async function init() {
  const res = await fetch('/auth/status');
  const { registered, enrollmentAvailable } = await res.json();
  if (!registered) {
    document.body.classList.toggle('login-enroll', enrollmentAvailable);
    document.body.classList.toggle('login-closed', !enrollmentAvailable);
    setStatus(enrollmentAvailable
      ? 'No passkey registered — use the one-time enrollment code below'
      : 'No passkey registered and enrollment is currently closed');
  }
}

document.getElementById('signInBtn')?.addEventListener('click', () => {
  signIn().catch(console.error);
});
document.getElementById('registerBtn')?.addEventListener('click', (event) => {
  event.preventDefault();
  register().catch(console.error);
});
init().catch(console.error);

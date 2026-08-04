(function () {
  const PREFIX = 'PLAYPOCKET_SHARE_V1:';
  const MAX_CODE_BYTES = 500 * 1024;

  function encode(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function createCode(payload) {
    const code = `${PREFIX}${encode(payload)}`;
    if (new Blob([code]).size > MAX_CODE_BYTES) throw new Error('share-code-too-large');
    return code;
  }

  function parseCode(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text.startsWith(PREFIX)) throw new Error('invalid-share-code');
    if (new Blob([text]).size > MAX_CODE_BYTES) throw new Error('share-code-too-large');
    return decode(text.slice(PREFIX.length));
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {}
    }
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) throw new Error('copy-failed');
  }

  window.PlayPocketShare = { createCode, parseCode, copyText };
}());

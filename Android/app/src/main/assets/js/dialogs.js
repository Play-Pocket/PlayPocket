(function () {
  'use strict';

  const PP = window.PP;

  function promptText({ title, label, value = '', okLabel = 'OK', cancelLabel = 'キャンセル', maxLength = 80 }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const titleId = `promptTitle-${Date.now()}`;

      const modal = document.createElement('div');
      modal.className = 'settings-modal prompt-modal open';
      modal.setAttribute('aria-hidden', 'false');

      const card = document.createElement('div');
      card.className = 'settings-card prompt-card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', titleId);

      const head = document.createElement('div');
      head.className = 'settings-head';
      const heading = document.createElement('h2');
      heading.id = titleId;
      heading.textContent = title;
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'small-btn settings-close';
      closeBtn.setAttribute('aria-label', '閉じる');
      closeBtn.textContent = '×';
      head.append(heading, closeBtn);

      const field = document.createElement('label');
      field.className = 'prompt-field';
      const caption = document.createElement('span');
      caption.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'prompt-input';
      input.maxLength = maxLength;
      input.value = value;
      input.autocomplete = 'off';
      field.append(caption, input);

      const actions = document.createElement('div');
      actions.className = 'prompt-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn';
      cancelBtn.textContent = cancelLabel;
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'btn share-primary';
      okBtn.textContent = okLabel;
      actions.append(cancelBtn, okBtn);

      card.append(head, field, actions);
      modal.appendChild(card);
      document.body.appendChild(modal);

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        modal.remove();
        if (previous && typeof previous.focus === 'function') {
          try { previous.focus(); } catch {}
        }
        resolve(result);
      };

      okBtn.addEventListener('click', () => finish(input.value));
      cancelBtn.addEventListener('click', () => finish(null));
      closeBtn.addEventListener('click', () => finish(null));
      modal.addEventListener('mousedown', (event) => {
        if (event.target === modal) finish(null);
      });
      modal.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        } else if (event.key === 'Enter' && event.target === input && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          finish(input.value);
        }
      });

      input.focus();
      input.select();
    });
  }

  PP.dialogs = Object.freeze({ promptText });
}());

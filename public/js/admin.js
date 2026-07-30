(function () {
  const socket = io();
  let roomCode = null;
  let adminToken = null;
  let lastState = null;

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'poker_admin_session';

  const viewSetup = $('view-setup');
  const viewPanel = $('view-panel');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showError(msg) {
    $('error-banner').innerHTML = `<div class="error-banner">${escapeHtml(msg)}</div>`;
    setTimeout(() => { $('error-banner').innerHTML = ''; }, 4500);
  }

  function saveSession(code, token) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ code, token }));
  }

  function enterPanel(code, token, table) {
    roomCode = code;
    adminToken = token;
    viewSetup.classList.add('hidden');
    viewPanel.classList.remove('hidden');
    $('room-code').textContent = code;
    $('admin-token-display').textContent = token;
    const link = `${location.origin}/?code=${code}`;
    $('share-link').innerHTML = `<a href="${link}" style="color:#9fd8b8" target="_blank">${link}</a>`;
    render(table);
  }

  // ---------- create / reattach ----------

  $('btn-create').addEventListener('click', () => {
    socket.emit('create_room', {
      smallBlind: Number($('cfg-sb').value),
      bigBlind: Number($('cfg-bb').value),
      defaultBuyIn: Number($('cfg-buyin').value),
      timerSeconds: Number($('cfg-timer').value),
    }, (res) => {
      if (!res.ok) { $('setup-error').innerHTML = `<div class="error-banner">${escapeHtml(res.error)}</div>`; return; }
      saveSession(res.code, res.adminToken);
      enterPanel(res.code, res.adminToken, res.table);
    });
  });

  $('btn-reattach').addEventListener('click', () => {
    const code = $('reattach-code').value.trim().toUpperCase();
    const token = $('reattach-token').value.trim();
    socket.emit('admin_auth', { code, adminToken: token }, (res) => {
      if (!res.ok) { $('setup-error').innerHTML = `<div class="error-banner">${escapeHtml(res.error)}</div>`; return; }
      saveSession(code, token);
      enterPanel(code, token, res.table);
    });
  });

  socket.on('connect', () => {
    if (roomCode && adminToken) {
      socket.emit('admin_auth', { code: roomCode, adminToken }, (res) => { if (res.ok) render(res.table); });
      return;
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const { code, token } = JSON.parse(saved);
      socket.emit('admin_auth', { code, adminToken: token }, (res) => {
        if (res.ok) enterPanel(code, token, res.table);
      });
    }
  });

  socket.on('room_state', (table) => {
    if (roomCode && table.code === roomCode) render(table);
  });
  socket.on('error_message', (msg) => showError(msg));

  function adminEmit(event, data) {
    socket.emit(event, data || {}, (res) => { if (!res.ok) showError(res.error); });
  }

  // ---------- game controls ----------

  $('btn-start-hand').addEventListener('click', () => adminEmit('admin:start_hand'));
  $('btn-reveal-next').addEventListener('click', () => adminEmit('admin:reveal_next'));
  $('btn-showdown').addEventListener('click', () => adminEmit('admin:start_showdown'));

  $('btn-set-blinds').addEventListener('click', () => {
    adminEmit('admin:set_blinds', { sb: Number($('set-sb').value), bb: Number($('set-bb').value) });
  });
  $('btn-set-timer').addEventListener('click', () => {
    adminEmit('admin:set_timer_seconds', { seconds: Number($('set-timer').value) });
  });
  $('btn-set-buyin').addEventListener('click', () => {
    adminEmit('admin:set_default_buyin', { amount: Number($('set-buyin').value) });
  });

  // ---------- render ----------

  const STAGE_LABELS = {
    waiting: 'очікування', preflop: 'префлоп', flop: 'флоп', turn: 'терн', river: 'рівер',
    showdown: 'шоудаун', 'hand-over': 'кінець хенду',
  };

  function render(state) {
    lastState = state;
    $('pot-amount').textContent = state.pot;
    $('hand-number').textContent = state.handNumber;
    $('stage-badge').textContent = STAGE_LABELS[state.stage] || state.stage;
    $('blinds').textContent = `${state.smallBlind}/${state.bigBlind}`;
    const turnSeat = state.seats.find((s) => s.seat === state.currentTurnSeat);
    $('turn-name').textContent = turnSeat ? turnSeat.name : '-';

    if (document.activeElement.id !== 'set-sb') $('set-sb').value = state.smallBlind;
    if (document.activeElement.id !== 'set-bb') $('set-bb').value = state.bigBlind;
    if (document.activeElement.id !== 'set-timer') $('set-timer').value = state.timerSeconds;
    if (document.activeElement.id !== 'set-buyin') $('set-buyin').value = state.defaultBuyIn;

    const canStart = state.stage === 'waiting' || state.stage === 'hand-over';
    $('btn-start-hand').disabled = !canStart;
    $('btn-start-hand').textContent = state.handNumber === 0 ? 'Почати хенд' : 'Наступний хенд';

    const canReveal = state.bettingRoundComplete && ['preflop', 'flop', 'turn'].includes(state.stage);
    $('btn-reveal-next').disabled = !canReveal;
    const nextLabel = { preflop: 'Відкрити флоп', flop: 'Відкрити терн', turn: 'Відкрити рівер' }[state.stage];
    $('btn-reveal-next').textContent = nextLabel || 'Відкрити наступну карту';

    $('btn-showdown').disabled = !(state.stage === 'river' && state.bettingRoundComplete);

    renderPots(state);
    renderSeats(state);
    renderUnseated(state);
    renderLog(state);
  }

  function renderPots(state) {
    const block = $('pots-block');
    if (state.stage !== 'showdown' || !state.pots.length) {
      block.classList.add('hidden');
      return;
    }
    block.classList.remove('hidden');
    const list = $('pots-list');
    list.innerHTML = '';
    state.pots.forEach((pot, i) => {
      const div = document.createElement('div');
      div.className = 'pot-block';
      if (pot.awarded) {
        const names = pot.winnerSeats.map((seat) => seatName(state, seat)).join(', ');
        div.innerHTML = `<strong>Банк ${i + 1}: ${pot.amount}</strong> — виграно: ${escapeHtml(names)}`;
      } else {
        const checks = pot.eligibleSeats.map((seat) => `
          <label><input type="checkbox" data-pot="${i}" data-seat="${seat}" /> ${escapeHtml(seatName(state, seat))}</label>
        `).join('');
        div.innerHTML = `
          <strong>Банк ${i + 1}: ${pot.amount}</strong>
          <div class="winner-pick" style="margin:8px 0;">${checks}</div>
          <button class="btn-secondary small-btn" data-award="${i}">Присудити переможцю(ям)</button>
        `;
      }
      list.appendChild(div);
    });
    list.querySelectorAll('[data-award]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const potIndex = Number(btn.dataset.award);
        const winnerSeats = [...list.querySelectorAll(`[data-pot="${potIndex}"]:checked`)].map((el) => Number(el.dataset.seat));
        if (!winnerSeats.length) { showError('Оберіть хоча б одного переможця'); return; }
        adminEmit('admin:award_pot', { potIndex, winnerSeats });
      });
    });
  }

  function seatName(state, seat) {
    const s = state.seats.find((x) => x.seat === seat);
    return s ? s.name : `Місце ${seat + 1}`;
  }

  function renderSeats(state) {
    const list = $('seats-list');
    list.innerHTML = '';
    state.seats.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'seat-row';
      if (s.empty) {
        row.innerHTML = `<div class="info muted">Місце ${s.seat + 1} — вільно</div>`;
      } else {
        const isButton = s.seat === state.dealerButtonSeat ? ' 🔘' : '';
        row.innerHTML = `
          <div class="info">
            <strong>${escapeHtml(s.name)}${isButton}</strong> — ${s.chips} фішок
            ${s.committedThisRound ? ` (ставка ${s.committedThisRound})` : ''}
            ${s.handStatus === 'folded' ? ' · пас' : ''}
            ${s.handStatus === 'all-in' ? ' · ва-банк' : ''}
            ${s.sittingOut ? ' · не грає' : ''}
            ${!s.connected ? ' · офлайн' : ''}
          </div>
          <button class="btn-secondary small-btn" data-adjust="${s.playerId}">+/- фішки</button>
          <button class="btn-secondary small-btn" data-sitout="${s.playerId}" data-value="${!s.sittingOut}">${s.sittingOut ? 'Повернути' : 'Сидить осторонь'}</button>
          <button class="btn-danger small-btn" data-kick="${s.playerId}">Видалити</button>
        `;
      }
      list.appendChild(row);
    });

    list.querySelectorAll('[data-adjust]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = prompt('На скільки змінити кількість фішок? (наприклад -50 або 200)');
        if (delta === null || delta === '') return;
        adminEmit('admin:adjust_chips', { playerId: btn.dataset.adjust, delta: Number(delta) });
      });
    });
    list.querySelectorAll('[data-sitout]').forEach((btn) => {
      btn.addEventListener('click', () => {
        adminEmit('admin:set_sitting_out', { playerId: btn.dataset.sitout, sittingOut: btn.dataset.value === 'true' });
      });
    });
    list.querySelectorAll('[data-kick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (confirm('Видалити гравця зі столу?')) adminEmit('admin:kick', { playerId: btn.dataset.kick });
      });
    });
  }

  function renderUnseated(state) {
    const list = $('unseated-list');
    if (!state.unseatedPlayers.length) {
      list.innerHTML = '<p class="muted">Немає гравців без місця</p>';
      return;
    }
    const emptySeats = state.seats.filter((s) => s.empty);
    list.innerHTML = state.unseatedPlayers.map((p) => `
      <div class="seat-row">
        <div class="info">${escapeHtml(p.name)} ${!p.connected ? '· офлайн' : ''}</div>
        ${emptySeats.length ? `
          <select data-seat-for="${p.id}">
            ${emptySeats.map((s) => `<option value="${s.seat}">Місце ${s.seat + 1}</option>`).join('')}
          </select>
          <button class="btn-primary small-btn" data-seat-btn="${p.id}">Посадити</button>
        ` : '<span class="muted">немає вільних місць</span>'}
      </div>
    `).join('');

    list.querySelectorAll('[data-seat-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const playerId = btn.dataset.seatBtn;
        const select = list.querySelector(`[data-seat-for="${playerId}"]`);
        const seatIndex = Number(select.value);
        adminEmit('admin:seat_player', { playerId, seatIndex, chips: lastState.defaultBuyIn });
      });
    });
  }

  function renderLog(state) {
    $('log').innerHTML = state.actionLog.map((e) => `<div>${escapeHtml(e.text)}</div>`).join('');
  }
})();

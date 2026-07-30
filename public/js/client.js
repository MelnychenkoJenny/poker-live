(function () {
  const socket = io();
  let roomCode = null;
  let myPlayerId = null;
  let lastState = null;
  let timerInterval = null;

  const $ = (id) => document.getElementById(id);

  const viewJoin = $('view-join');
  const viewTable = $('view-table');
  const actionsBar = $('actions-bar');
  const errorBanner = $('error-banner');
  const seatPicker = $('seat-picker');
  const seatPickerList = $('seat-picker-list');

  function showError(msg) {
    errorBanner.innerHTML = `<div class="error-banner">${escapeHtml(msg)}</div>`;
    setTimeout(() => { errorBanner.innerHTML = ''; }, 4000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function storageKey(code) { return `poker_player_${code}`; }

  // ---------- join ----------

  (function prefillFromQuery() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (code) $('join-code').value = code.toUpperCase();
  })();

  $('join-btn').addEventListener('click', () => {
    const code = $('join-code').value.trim().toUpperCase();
    const name = $('join-name').value.trim();
    if (!code || !name) {
      $('join-error').innerHTML = `<div class="error-banner">Введіть код кімнати і ім'я</div>`;
      return;
    }
    const savedPlayerId = localStorage.getItem(storageKey(code));
    socket.emit('join_room', { code, name, playerId: savedPlayerId }, (res) => {
      if (!res.ok) {
        $('join-error').innerHTML = `<div class="error-banner">${escapeHtml(res.error)}</div>`;
        return;
      }
      roomCode = code;
      myPlayerId = res.playerId;
      localStorage.setItem(storageKey(code), myPlayerId);
      viewJoin.classList.add('hidden');
      viewTable.classList.remove('hidden');
      render(res.table);
    });
  });

  socket.on('room_state', (table) => {
    if (roomCode && table.code === roomCode) render(table);
  });

  socket.on('error_message', (msg) => showError(msg));

  socket.on('connect', () => {
    if (roomCode && myPlayerId) {
      socket.emit('join_room', { code: roomCode, name: undefined, playerId: myPlayerId }, (res) => {
        if (res.ok) render(res.table);
      });
    }
  });

  // ---------- seat picking ----------

  function renderSeatPicker(state) {
    const me = findMe(state);
    const iAmSeated = me && me.seat !== undefined && !me.empty;
    if (iAmSeated) {
      seatPicker.classList.add('hidden');
      return;
    }
    seatPicker.classList.remove('hidden');
    seatPickerList.innerHTML = '';
    state.seats.forEach((s) => {
      if (!s.empty) return;
      const btn = document.createElement('button');
      btn.className = 'btn-secondary';
      btn.style.minWidth = '70px';
      btn.textContent = `Місце ${s.seat + 1}`;
      btn.addEventListener('click', () => {
        socket.emit('take_seat', { seatIndex: s.seat }, (res) => {
          if (!res.ok) showError(res.error);
        });
      });
      seatPickerList.appendChild(btn);
    });
  }

  function findMe(state) {
    return state.seats.find((s) => s.isYou) || null;
  }

  // ---------- rendering ----------

  const STAGE_LABELS = {
    waiting: 'очікування', preflop: 'префлоп', flop: 'флоп', turn: 'терн', river: 'рівер',
    showdown: 'шоудаун', 'hand-over': 'кінець хенду',
  };
  const STATUS_LABELS = { folded: 'пас', 'all-in': 'ва-банк', idle: 'поза грою' };

  function render(state) {
    lastState = state;
    $('pot-amount').textContent = state.pot;
    $('hand-number').textContent = state.handNumber;
    $('stage-badge').textContent = STAGE_LABELS[state.stage] || state.stage;
    $('blinds').textContent = `${state.smallBlind}/${state.bigBlind}`;

    renderSeatPicker(state);
    renderSeats(state);
    renderTimer(state);
    renderLog(state);
    renderActions(state);
  }

  function renderSeats(state) {
    const grid = $('seats-grid');
    grid.innerHTML = '';
    state.seats.forEach((s) => {
      const div = document.createElement('div');
      if (s.empty) {
        div.className = 'seat empty';
        div.textContent = `Місце ${s.seat + 1} вільне`;
        grid.appendChild(div);
        return;
      }
      const classes = ['seat'];
      if (s.handStatus === 'folded') classes.push('folded');
      if (s.seat === state.currentTurnSeat) classes.push('acting');
      if (s.isYou) classes.push('you');
      div.className = classes.join(' ');

      const isButton = s.seat === state.dealerButtonSeat;
      div.innerHTML = `
        ${isButton ? '<div class="button-chip">D</div>' : ''}
        <div class="name">${escapeHtml(s.name)} ${s.isYou ? '(ви)' : ''}
          ${STATUS_LABELS[s.handStatus] ? `<span class="tag">${STATUS_LABELS[s.handStatus]}</span>` : ''}
          ${s.sittingOut ? '<span class="tag">не грає</span>' : ''}
        </div>
        <div class="chips">Фішки: ${s.chips}</div>
        ${s.committedThisRound > 0 ? `<div class="bet">Ставка: ${s.committedThisRound}</div>` : ''}
        ${!s.connected ? '<div class="disconnected">офлайн</div>' : ''}
      `;
      grid.appendChild(div);
    });
  }

  function renderTimer(state) {
    const wrap = $('timer-wrap');
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (!state.turnDeadline || state.currentTurnSeat === null) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    const turnSeat = state.seats.find((s) => s.seat === state.currentTurnSeat);
    $('turn-name').textContent = turnSeat ? turnSeat.name : '-';

    function tick() {
      const remaining = Math.max(0, Math.round((state.turnDeadline - Date.now()) / 1000));
      const el = $('timer-circle');
      el.textContent = remaining;
      el.classList.toggle('warn', remaining <= 5);
      if (remaining <= 0) clearInterval(timerInterval);
    }
    tick();
    timerInterval = setInterval(tick, 250);
  }

  function renderLog(state) {
    $('log').innerHTML = state.actionLog.map((e) => `<div>${escapeHtml(e.text)}</div>`).join('');
  }

  function renderActions(state) {
    const me = findMe(state);
    const myTurn = me && !me.empty && state.currentTurnSeat === me.seat &&
      ['preflop', 'flop', 'turn', 'river'].includes(state.stage);

    if (!myTurn) {
      actionsBar.classList.add('hidden');
      return;
    }
    actionsBar.classList.remove('hidden');
    $('raise-box').classList.add('hidden');

    const callAmount = Math.max(0, state.currentBetAmount - me.committedThisRound);
    const checkCallBtn = $('btn-checkcall');
    if (callAmount > 0) {
      checkCallBtn.textContent = `Колл ${Math.min(callAmount, me.chips)}`;
    } else {
      checkCallBtn.textContent = 'Чек';
    }

    const raiseInput = $('raise-amount');
    const minRaiseTo = state.currentBetAmount + state.minRaise;
    const maxRaiseTo = me.committedThisRound + me.chips;
    raiseInput.min = Math.min(minRaiseTo, maxRaiseTo);
    raiseInput.max = maxRaiseTo;
    raiseInput.value = Math.min(minRaiseTo, maxRaiseTo);
    $('btn-raise').style.display = maxRaiseTo > state.currentBetAmount ? '' : 'none';
  }

  $('btn-fold').addEventListener('click', () => {
    socket.emit('player:action', { type: 'fold' }, (res) => { if (!res.ok) showError(res.error); });
  });

  $('btn-checkcall').addEventListener('click', () => {
    const me = findMe(lastState);
    const callAmount = Math.max(0, lastState.currentBetAmount - me.committedThisRound);
    const type = callAmount > 0 ? 'call' : 'check';
    socket.emit('player:action', { type }, (res) => { if (!res.ok) showError(res.error); });
  });

  $('btn-raise').addEventListener('click', () => {
    $('raise-box').classList.toggle('hidden');
  });

  $('raise-confirm').addEventListener('click', () => {
    const amount = Number($('raise-amount').value);
    socket.emit('player:action', { type: 'raise', amount }, (res) => {
      if (!res.ok) showError(res.error);
      else $('raise-box').classList.add('hidden');
    });
  });
})();

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

  // ---------- help modal ----------
  const helpLink = $('help-link');
  const helpModal = $('help-modal');
  helpLink.addEventListener('click', (e) => {
    e.preventDefault();
    helpModal.classList.remove('hidden');
  });
  $('help-close').addEventListener('click', () => helpModal.classList.add('hidden'));
  helpModal.addEventListener('click', (e) => {
    if (e.target === helpModal) helpModal.classList.add('hidden');
  });

  // ---------- winner overlay ----------
  // Shown when one player has busted everyone else (the whole session is
  // over, not just a hand). Dismissible, but only reappears if a *new*
  // winner shows up later (e.g. after the dealer resets the game).
  let dismissedWinner = null;
  $('winner-close').addEventListener('click', () => {
    dismissedWinner = lastState && lastState.winnerName;
    $('winner-overlay').classList.add('hidden');
  });

  // ---------- shuffle overlay ----------
  // Shown between hands (no hand in progress yet) — dismissible, but
  // resets once a new hand actually starts so it shows again next gap.
  // Delayed after a hand ends (see handOverShuffleReady in render()) so
  // players see the win badge on the table before it gets covered up.
  let shuffleDismissed = false;
  let previousStage = null;
  let handOverShuffleReady = false;
  let handOverShuffleTimer = null;
  $('shuffle-close').addEventListener('click', () => {
    shuffleDismissed = true;
    $('shuffle-overlay').classList.add('hidden');
  });

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
    $('level-progress').textContent = state.handsPerLevel > 0
      ? `· ще ${Math.max(0, state.handsPerLevel - state.handsAtCurrentLevel)} хенд(и/ів) до підвищення`
      : '';
    $('paused-banner').classList.toggle('hidden', !state.paused);

    const showWinner = !!state.winnerName && state.winnerName !== dismissedWinner;
    $('winner-overlay').classList.toggle('hidden', !showWinner);
    if (showWinner) $('winner-name').textContent = `${state.winnerName} забирає весь банк! 🏆`;
    if (!state.winnerName) dismissedWinner = null; // reset once the game moves past that win

    // When a hand just ended, let players see who won (the chip badge on
    // the seat) for a few seconds before the shuffle gif covers the table.
    const justEnteredHandOver = state.stage === 'hand-over' && previousStage !== 'hand-over';
    if (justEnteredHandOver) {
      handOverShuffleReady = false;
      clearTimeout(handOverShuffleTimer);
      handOverShuffleTimer = setTimeout(() => {
        handOverShuffleReady = true;
        if (lastState && lastState.stage === 'hand-over' && !shuffleDismissed) {
          $('shuffle-overlay').classList.remove('hidden');
        }
      }, 3500);
    }
    if (state.stage !== 'hand-over') handOverShuffleReady = false;
    previousStage = state.stage;

    const betweenHands = state.stage === 'waiting' || state.stage === 'hand-over';
    if (!betweenHands) shuffleDismissed = false; // reset so it shows again next gap
    const shuffleAllowedNow = state.stage === 'waiting' || (state.stage === 'hand-over' && handOverShuffleReady);
    $('shuffle-overlay').classList.toggle('hidden', showWinner || shuffleDismissed || !shuffleAllowedNow);

    renderSeatPicker(state);
    renderSeats(state);
    renderTimer(state);
    renderLog(state);
    renderActions(state);
  }

  // Plain CSS oval table (see .table-oval in style.css) — no image, so
  // seats are just placed evenly around an ellipse by simple trigonometry.
  const TOTAL_SEATS = 9;
  // Same radius on both axes: since left% is relative to the container's
  // width and top% to its height, an equal radius already traces an
  // ellipse matching the container's own (wide) aspect ratio. Kept small
  // enough that a seat box (up to ~8% half-width) never crosses the edge.
  const RADIUS = 40;

  function seatPosition(index) {
    const angle = -Math.PI / 2 + index * ((2 * Math.PI) / TOTAL_SEATS);
    const x = 50 + RADIUS * Math.cos(angle);
    const y = 50 + RADIUS * Math.sin(angle);
    return { left: `${x}%`, top: `${y}%` };
  }

  function renderSeats(state) {
    const ring = $('seats-grid');
    ring.innerHTML = '';
    const gameStarted = state.handNumber > 0;
    state.seats.forEach((s) => {
      if (s.empty && gameStarted) return; // once the game is running, leave empty seats blank

      const pos = document.createElement('div');
      pos.className = 'seat-pos';
      const { left, top } = seatPosition(s.seat);
      pos.style.left = left;
      pos.style.top = top;

      const div = document.createElement('div');
      if (s.empty) {
        div.className = 'seat empty';
        div.textContent = `Місце ${s.seat + 1}`;
        pos.appendChild(div);
        ring.appendChild(pos);
        return;
      }
      const classes = ['seat'];
      if (s.handStatus === 'folded') classes.push('folded');
      if (s.seat === state.currentTurnSeat) classes.push('acting');
      if (s.isYou) classes.push('you');
      div.className = classes.join(' ');

      const isButton = s.seat === state.dealerButtonSeat;
      const win = state.lastHandWinners.find((w) => w.seat === s.seat);
      div.innerHTML = `
        ${isButton ? '<div class="button-chip">D</div>' : ''}
        <div class="name">${escapeHtml(s.name)}
          ${STATUS_LABELS[s.handStatus] ? `<span class="tag">${STATUS_LABELS[s.handStatus]}</span>` : ''}
          ${s.sittingOut ? '<span class="tag">не грає</span>' : ''}
        </div>
        <div class="chips">${s.chips}</div>
        ${s.committedThisRound > 0 ? `<div class="bet">Ставка: ${s.committedThisRound}</div>` : ''}
        ${win ? `<div class="win-badge"><img src="/images/fishka.png" alt="" /> +${win.amount}</div>` : ''}
        ${!s.connected ? '<div class="disconnected">офлайн</div>' : ''}
      `;
      pos.appendChild(div);
      ring.appendChild(pos);
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

    if (!myTurn || state.paused) {
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
    const me = findMe(lastState);
    const callAmount = me ? Math.max(0, lastState.currentBetAmount - me.committedThisRound) : 0;
    if (callAmount === 0) {
      const ok = confirm('Секунду... ставок немає, чек безкоштовний — а ти скидаєш карти? Це трохи нерозумний вчинок. Точно пасуєш?');
      if (!ok) return;
    }
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

  $('btn-allin').addEventListener('click', () => {
    const me = findMe(lastState);
    if (!me) return;
    const shoveTo = me.committedThisRound + me.chips;
    const type = shoveTo > lastState.currentBetAmount ? 'raise' : 'call';
    socket.emit('player:action', { type, amount: shoveTo }, (res) => { if (!res.ok) showError(res.error); });
  });
})();

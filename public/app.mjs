import {DemoGame} from './demo.mjs';

const $ = id => document.getElementById(id);
const escapeHTML = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const signed = n => `${n > 0 ? '+' : ''}${fmt(n)}`;
const fmt = n => new Intl.NumberFormat('ru-RU').format(n || 0);
const storage = {get(k) { try { return localStorage.getItem(`svoi:${k}`); } catch { return null; } }, set(k,v) { try { v === null ? localStorage.removeItem(`svoi:${k}`) : localStorage.setItem(`svoi:${k}`,v); } catch {} }};
const standalone = Boolean(window.__STANDALONE__);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const symbols = {s:'♠',h:'♥',d:'♦',c:'♣'};
const suitNames = {s:'пики',h:'червы',d:'бубны',c:'трефы'};
const colors = ['#63785f','#6b7893','#a1836c','#737759','#8b7484','#688b88'];
const positions = [[50,88],[13,69],[13,27],[50,12],[87,27],[87,69]];
let cloud = null;
let config = {authMode: standalone ? 'preview' : 'unknown'};
let token = storage.get('token'), user = null, state = null, transport = null;
let connected = false, busy = false, clockOffset = 0, toastTimer, sound = false, audio;
let raiseOpen = false, inspectedHand = null;
let rebuyReviewOpen=false,rebuyReviewId=null,rebuyClosing=false;
function telegram() { return window.Telegram?.WebApp; }
function toast(text) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4300);
}
function modal(html) { $('modal-content').innerHTML = html; if (!$('modal').open) $('modal').showModal(); }
async function closeModal() {
  if(rebuyClosing)return false;
  if(rebuyReviewOpen){
    rebuyClosing=true;
    const result=await send('endRebuyReview',{reviewId:rebuyReviewId});
    rebuyClosing=false;
    if(!result){toast('Закрытие окна не подтверждено. При потере связи сервер снимет паузу автоматически.');return false;}
    rebuyReviewOpen=false;rebuyReviewId=null;
  }
  $('modal').close();inspectedHand=null;return true;
}
function screen(name) { if(name!=='game')$('rebuy-notice').hidden=true; ['lobby','waiting-room','game'].forEach(id => $(id).hidden = id !== name); }
function tone(type = 'chip') {
  if (!sound || !audio) return;
  try {
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.type = 'sine'; osc.frequency.value = type === 'deal' ? 600 : type === 'win' ? 840 : 340;
    gain.gain.setValueAtTime(.035, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .09);
    osc.connect(gain); gain.connect(audio.destination); osc.start(); osc.stop(audio.currentTime + .1);
  } catch {}
}
async function api(path, data) {
  if (cloud) { const {data} = await cloud.auth.getSession(); token = data.session?.access_token; path = config.supabaseUrl + '/functions/v1/game' + path.replace('/api',''); }
  const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),12000);
  let response;
  try { response = await fetch(path, {signal:controller.signal,method: data === undefined ? 'GET' : 'POST',
    headers: {...(cloud?{apikey:config.publishableKey}:{}),...(data === undefined ? {} : {'Content-Type':'application/json'}), ...(token ? {Authorization:`Bearer ${token}`} : {})},
    ...(data === undefined ? {} : {body: JSON.stringify(data)})}); }
  catch(e){if(e.name==='AbortError')throw new Error('Сервер отвечает слишком долго. Повторите попытку.');throw e;}
  finally{clearTimeout(timeout);}
  const result = await response.json();
  if (!response.ok) { const e = new Error(result.error || 'Не удалось выполнить запрос'); e.status = response.status; throw e; }
  return result;
}
async function login(name = 'Игрок') {
  if (standalone) throw new Error('Для приватной комнаты запустите сервер из архива проекта');
  if (user && token) return user;
  if (cloud) {
    let {data} = await cloud.auth.getSession();
    if (!data.session) { const result = await cloud.auth.signInAnonymously({options:{data:{name}}}); if(result.error) throw result.error; data=result.data; }
    token=data.session.access_token; user={id:data.session.user.id,name:data.session.user.user_metadata?.name||name}; return user;
  }
  const initData = telegram()?.initData;
  if (!initData && !['dev','guest'].includes(config.authMode)) throw new Error('Откройте Mini App через своего Telegram-бота');
  const result = await api('/api/session', initData ? {initData} : {name});
  token = result.token; user = result.user; storage.set('token', token); return user;
}
class OnlineGame {
  constructor(roomId) { this.roomId = roomId; this.closed = false; this.controller = null; this.run(); }
  async run() {
    if(cloud) return this.cloudRun();
    let retry = 600;
    while (!this.closed) {
      this.controller = new AbortController();
      try {
        const response = await fetch(`/api/events?room=${encodeURIComponent(this.roomId)}`, {headers:{Authorization:`Bearer ${token}`}, signal:this.controller.signal});
        if (!response.ok) {
          const data = await response.json();
          if ([401,403,404].includes(response.status)) { this.closed = true; handlePacket({type: response.status === 401 ? 'expired':'denied', message:data.error}); return; }
          throw new Error(data.error);
        }
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        while (!this.closed) {
          const {value,done} = await reader.read(); if (done) break;
          buffer += decoder.decode(value,{stream:true});
          if (buffer.length > 1000000) throw new Error('Некорректный поток');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0,boundary); buffer = buffer.slice(boundary + 2);
            const data = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
            if (data) { setConnection(true); handlePacket(JSON.parse(data)); retry = 600; }
          }
        }
      } catch (e) { if (this.closed) return; }
      if (this.closed) return;
      setConnection(false);
      await new Promise(resolve => setTimeout(resolve,retry)); retry = Math.min(retry * 1.6,7000);
    }
  }
  async cloudRun() {
    this.channel=cloud.channel(`room:${this.roomId}:${user.id}`).on('postgres_changes',{event:'*',schema:'public',table:'svoi_views',filter:`room_id=eq.${this.roomId}`},()=>this.refresh()).subscribe(status=>{if(status==='SUBSCRIBED')this.refresh();else if(['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(status))setConnection(false);});
    await this.refresh();
    this.poll=setInterval(()=>this.refresh(),4000);
  }
  async refresh(){
    if(this.refreshing||this.closed)return;this.refreshing=true;
    try{const packet=await api(`/api/room?room=${this.roomId}`);if(!this.closed){setConnection(true);handlePacket(packet);}}
    catch(e){setConnection(false);if([401,403,404].includes(e.status)){this.close();handlePacket({type:'denied',message:e.message});}}
    finally{this.refreshing=false;}
  }
  async send(action, data = {}) {
    // Retry a lost response with exactly the same immutable action ID and payload.
    const payload={roomId:this.roomId,action,requestId:crypto.randomUUID(),handId:state?.table.handId,version:state?.table.version,...data};
    storage.set('pendingCommand',JSON.stringify(payload));
    let result;
    try{result=await api('/api/command',payload);}
    catch(e){if(e.status){storage.set('pendingCommand',null);throw e;}result=await api('/api/command',payload);}
    storage.set('pendingCommand',null);await this.refresh();return result;
  }
  close() { this.closed = true; this.controller?.abort();clearInterval(this.poll);if(this.channel)cloud.removeChannel(this.channel); }

}
function setConnection(value) {
  connected = value;
  $('connection').classList.toggle('offline', !value);
  $('connection').querySelector('span').textContent = state?.demo ? 'Локальное демо' : value ? 'На связи' : 'Восстанавливаем связь';
  updateActions();
}
function openRoom(roomId) {
  transport?.close(); state = null; storage.set('room',roomId); setConnection(false);
  $('waiting-title').textContent = 'Открываем стол';
  $('waiting-message').textContent = 'Подключаемся к приватной комнате.'; screen('waiting-room');
  transport = new OnlineGame(roomId);
}
function startDemo(mode = 'cash') {
  if (!['cash','tournament'].includes(mode)) mode = 'cash';
  transport?.close(); state = null; busy = false; raiseOpen = false; closeModal();
  transport = new DemoGame(handlePacket, user?.name || 'Вы', mode);
  setConnection(true);
}
function updateResume() { $('resume-room').hidden = standalone || !user || !storage.get('room'); }
async function home({forget = false} = {}) {
  if(rebuyReviewOpen && !await closeModal())return;
  transport?.close(); transport = null; state = null; connected = false;
  if (forget) storage.set('room',null);
  screen('lobby'); closeModal(); updateResume();
}
function handlePacket(packet) {
  if (packet.type === 'pending') {
    screen('waiting-room'); $('waiting-title').textContent = packet.roomName;
    $('waiting-message').textContent = packet.message; return;
  }
  if (['denied','closed','expired'].includes(packet.type)) {
    if (packet.type === 'expired') { token = null; user = null; storage.set('token',null); }
    home({forget:true}); toast(packet.message || 'Комната закрыта'); return;
  }
  if (packet.type !== 'state') return;
  const previous = state; state = packet;
  const pending=storage.get('pendingCommand');
  if(pending&&!busy){const d=JSON.parse(pending);if(d.roomId===packet.room.id){busy=true;api('/api/command',d).then(()=>storage.set('pendingCommand',null)).catch(e=>{if(e.status){storage.set('pendingCommand',null);toast(e.message);}}).finally(()=>{busy=false;updateActions();});}} clockOffset = packet.table.serverNow - Date.now();
  if (packet.demo) connected = true;
  screen('game'); render(previous);
}
function card(code, extra = '') {
  if (code === '??') return '<div class="playing-card back" aria-label="Закрытая карта"><span>♠</span></div>';
  const red = code[1] === 'h' || code[1] === 'd';
  const rank = code[0] === 'T' ? '10' : code[0];
  return `<div class="playing-card ${red?'red ':''}${extra}" data-card="${code}" aria-label="${rank}, ${suitNames[code[1]]}"><b>${rank}</b><span>${symbols[code[1]]}</span><small>${rank}</small></div>`;
}
function render(previous) {
  const {table:t, room:r, me} = state, mine = t.players.find(p => p.id === me);
  const isNewHand = !previous || previous.table.handId !== t.handId;
  const idle = ['waiting','showdown'].includes(t.phase);
  const winning = new Set(t.payouts.flatMap(p => p.bestCards));
  const originSeat = mine?.seat || 0;
  $('room-name').textContent = r.name;
  $('room-eyebrow').textContent = state.demo ? 'ПРОБНЫЙ СТОЛ / УСЛОВНЫЕ ФИШКИ' : 'ПРИВАТНЫЙ СТОЛ / ТОЛЬКО ПО ПРИГЛАШЕНИЮ';
  $('demo-banner').hidden = !state.demo;
  $('invite-button').hidden = state.demo || r.ownerId !== me;
  $('hand-counter').textContent = t.handId ? `РАЗДАЧА #${String(t.handId).padStart(2,'0')}` : 'ЖДЁМ ДРУЗЕЙ';
  $('pot-amount').textContent = fmt(t.phase === 'showdown' ? t.lastPot : t.pot);
  $('pot-display').querySelector('.pot-label').textContent = t.phase === 'showdown' ? 'БАНК РАЗДАЧИ' : 'ОБЩИЙ БАНК';
  $('table-players').textContent = `${t.players.length} / ${t.maxPlayers} за столом`;
  $('table-blinds').textContent = `${t.mode === 'tournament' ? `Турнир · ур. ${t.level + 1}` : 'Кэш'} ${fmt(t.smallBlind)} / ${fmt(t.bigBlind)}${t.straddle ? ` / ${fmt(t.straddle.amount)}` : ''}`;
  $('pending-changes').textContent=t.pendingBlinds?`Со следующей раздачи: ${fmt(t.pendingBlinds.smallBlind)} / ${fmt(t.pendingBlinds.bigBlind)}`:t.pendingLevel>t.level?`Со следующей раздачи: уровень ${t.pendingLevel+1}`:'';
  $('pending-changes').hidden=!$('pending-changes').textContent;
  $('street-label').textContent = {waiting:'СОБИРАЕМ ДРУЗЕЙ',preflop:'ПРЕФЛОП',flop:'ФЛОП',turn:'ТЁРН',river:'РИВЕР',showdown:'ВСКРЫТИЕ'}[t.phase];
  if (t.phase === 'showdown' && !t.board.length) $('street-label').textContent = 'РАЗДАЧА ЗАВЕРШЕНА';
  $('board').innerHTML = Array.from({length:5},(_,i) => t.board[i] ? card(t.board[i],winning.has(t.board[i])?'winning':'') : '<div class="card-placeholder" aria-label="Карта ещё не открыта">♠</div>').join('');
  $('seats').innerHTML = Array.from({length:6}, (_,pos) => {
    const seat = (originSeat + pos) % 6, p = t.players.find(p => p.seat === seat), [x,y] = positions[pos];
    if (!p) return `<div class="seat empty-seat" style="left:${x}%;top:${y}%" data-position="${pos}"><div class="avatar">+</div><div class="seat-label"><span class="seat-name">Для друга</span></div></div>`;
    const self = p.id === me, winner = t.payouts.some(w => w.id === p.id);
    return `<div class="seat ${self?'self ':''}${p.folded?'folded ':''}${t.actor===p.id?'turn ':''}${winner?'winner ':''}${p.sittingOut?'sitting-out ':''}${!p.connected?'offline ':''}" data-player="${escapeHTML(p.id)}" data-position="${pos}" style="left:${x}%;top:${y}%"><div class="seat-hand">${p.cards.map(c => card(c,winning.has(c)?'winning':'')).join('')}</div><div class="avatar" style="background:${colors[p.seat%6]}">${escapeHTML((p.name || '?')[0])}</div>${t.dealer===p.seat?'<span class="dealer-button" aria-label="Дилер">D</span>':''}<div class="seat-label"><span class="seat-name">${escapeHTML(p.name)}${self&&p.name!=='Вы'?' · вы':''}${p.bot?' · бот':''}</span><span class="seat-stack">${fmt(p.stack)}</span></div><div class="seat-action">${escapeHTML(p.returnPending ? (p.missedHands && t.mode==='cash' ? 'Ждёт BB' : 'Со следующей руки') : p.sittingOut ? 'Не играет' : p.missedHands && t.mode==='cash' ? 'Ждёт BB' : p.lastAction || (!p.connected?'Нет связи':''))}</div>${p.bet?`<span class="bet-badge"><i class="tiny-chip"></i>${fmt(p.bet)}</span>`:''}</div>`;
  }).join('');
  $('result-label').hidden = t.phase !== 'showdown';
  if (t.phase === 'showdown') {
    $('result-label').innerHTML = t.payouts.length === 1
      ? `${escapeHTML(t.payouts[0].name)} получает <strong>${fmt(t.payouts[0].amount)}</strong><small>Итог стека: ${signed(t.payouts[0].net)} · разбор ниже</small>`
      : `Из банков выплачено <strong>${fmt(t.lastPot)}</strong><small>${t.payouts.length} получателей · разбор ниже</small>`;
  }
  $('settlement-button').hidden = !t.lastHand && t.phase !== 'showdown';
  $('settlement-button').textContent = t.phase === 'showdown' ? 'Разбор банков и выплат' : `Разбор раздачи #${t.lastHand?.handId || ''}`;
  $('hand-report-button').hidden = !t.handId;
  $('roster-count').textContent = `${t.players.length} / 6`;
  $('roster').innerHTML = t.players.map(p => `<div class="roster-row"><div class="roster-avatar" style="background:${colors[p.seat%6]}">${escapeHTML(p.name[0])}</div><div class="roster-info"><strong>${escapeHTML(p.name)}${p.id===me&&p.name!=='Вы'?' · вы':''}</strong><small>${p.returnPending?'Возвращается':p.sittingOut?'Не играет':p.bot?'Демо-бот':p.id===r.ownerId?'Хозяин стола':p.connected?'За столом':'Нет связи'}</small></div><span class="roster-stack">${fmt(p.stack)}</span></div>`).join('');
  $('history').innerHTML = t.history.slice(-9).reverse().map(e => `<div class="history-row ${escapeHTML(e.kind || '')}">${escapeHTML(e.text)}</div>`).join('');
  $('pending-requests').hidden = true; // Admission buy-ins use the same paused approval window.

  if (previous?.table.actor !== t.actor || isNewHand) raiseOpen = false;
  renderRebuys(previous);
  updateActions(); animateChanges(previous);
  try {const tg=telegram();if(tg?.initData && tg.isVersionAtLeast('6.2')) idle?tg.disableClosingConfirmation():tg.enableClosingConfirmation();} catch {}
  $('connection').querySelector('span').textContent = state.demo ? 'Локальное демо' : connected ? 'На связи':'Восстанавливаем связь';
}
function updateActions() {
  if (!state) return;
  const {table:t,room:r,me} = state, l = t.legal, mine = t.players.find(p => p.id === me);
  const idle = ['waiting','showdown'].includes(t.phase), yourTurn = Boolean(l);
  const canAct = yourTurn && connected && !busy && !t.rebuyReview;
  $('waiting-actions').hidden = !idle && !mine?.sittingOut; $('playing-actions').hidden = idle || mine?.sittingOut;
  $('turn-title').textContent = !connected ? 'Восстанавливаем связь' : idle ? t.phase === 'waiting' ? 'Вечер начинается' : 'Раздача завершена' : yourTurn ? 'Ваш ход' : `Ходит ${t.players.find(p => p.id === t.actor)?.name || 'игрок'}`;
  $('turn-indicator').classList.toggle('active',yourTurn && connected);
  $('turn-subtitle').textContent = yourTurn && connected ? l.toCall ? `К ответу ${fmt(l.callAmount)}` : 'Можно сделать чек' : '';
  $('fold').disabled = !canAct; $('check-call').disabled = !canAct; $('raise-toggle').disabled = !canAct || !l?.canRaise;
  $('check-call').querySelector('span').textContent = l?.toCall ? `Колл ${fmt(l.callAmount)}` : 'Чек';
  $('check-call').querySelector('small').textContent = l?.toCall && l.callAmount === mine?.stack ? 'Все ваши фишки' : l?.toCall ? 'Ответить на ставку' : 'Без ставки';
  $('raise-panel').hidden = !raiseOpen || !l?.canRaise;
  if (l?.canRaise) {
    const min = Math.min(l.minTo,l.maxTo), max = l.maxTo;
    for (const id of ['raise-range','raise-amount']) { $(id).min = min; $(id).max = max; }
    let value = Number($('raise-amount').value) || min; value = Math.min(max,Math.max(min,value));
    $('raise-amount').value = value; $('raise-range').value = value;
    $('confirm-raise').disabled = !canAct;
    $('confirm-raise').textContent = value === max ? `Олл-ин ${fmt(value)}` : `До ${fmt(value)}`;
  }
  $('start-hand').hidden = r.ownerId !== me || t.running;
  $('start-hand').disabled = !!t.rebuyReview || busy || !connected || t.tournamentOver || t.readyCount < 2;
  $('start-hand').innerHTML = 'Начать игру <span>→</span>';
  $('top-up').hidden = !idle || mine?.stack !== 0; $('top-up').disabled = busy || !connected;
  $('start-help').textContent = !t.running
    ? (r.ownerId === me ? (t.readyCount < 2 ? 'Подтвердите стартовые закупы — свой и друга — в окне запросов.' : 'Начните игру один раз. Дальше карты раздаются автоматически.') : 'Хозяин один раз запускает игру; далее — автораздача.')
    : mine?.sittingOut ? (mine.returnPending ? (t.mode === 'cash' && mine.missedHands ? 'Возвращение на большом блайнде. До этого новые карты не выдаются.' : 'Возвращение подтверждено. Эта раздача не возобновляется.') : 'Вы не играете. Для возвращения нажмите «Я вернулся».')
    : t.paused ? 'Стол на паузе. Текущая раздача всегда доигрывается.'
    : t.readyCount < 2 ? 'Ждём хотя бы двух готовых игроков с фишками.'
    : 'Следующая рука начнётся автоматически. Разбор предыдущей остаётся доступен.';
  $('participation-button').textContent = mine?.returnPending ? 'Отменить возвращение' : mine?.sittingOut ? 'Я вернулся' : 'Не играю';
  $('participation-button').disabled = !!t.rebuyReview || busy || !connected || t.tournamentOver || !!t.haltReason || (!mine?.stack && (idle || !mine?.inHand || mine?.folded));
  $('participation-button').setAttribute('aria-pressed', String(!!mine?.sittingOut));
  $('pause-table').hidden = r.ownerId !== me || !t.running || t.tournamentOver;
  $('pause-table').disabled = !!t.rebuyReview || busy || !connected || !!t.haltReason;
  $('pause-table').textContent = t.paused ? 'Продолжить игру' : idle ? 'Пауза стола' : 'Пауза после раздачи';
  $('participation-note').hidden = !mine?.sittingOut;
  $('participation-note').textContent = t.mode === 'tournament'
    ? 'Не играю: блайнды продолжают списываться. Уже сделанный олл-ин остаётся в игре.'
    : mine?.returnPending && mine?.missedHands ? 'Ожидайте большого блайнда: пауза не позволяет обходить обязательные ставки.'
    : 'Автопас только в свой ход. Уже сделанный олл-ин доигрывается; стек остаётся за вами.';
  if (mine?.sittingOut) $('turn-title').textContent = mine.returnPending ? 'Возвращение в игру' : 'Вы не играете';
  if (t.haltReason) { $('turn-title').textContent = 'Игра остановлена'; $('start-help').textContent = t.haltReason; }
  if (t.tournamentOver) { $('turn-title').textContent = 'Турнир завершён'; $('start-help').textContent = `Победитель: ${t.players.find(p => p.id === t.championId)?.name || ''}`; }
  if(t.rebuyReview)$('turn-title').textContent='Пауза · закуп в игре';
  $('request-rebuy').hidden=!!state.demo;
  $('request-rebuy').disabled=busy||!connected||!!t.haltReason;
  updateTimer();
}
function updateTimer() {
  if (!state) return;
  const t = state.table;
  const idle = ['waiting','showdown'].includes(t.phase);
  let status = '';
  if(t.rebuyReview)status='Закуп в игре · таймер хода приостановлен';
  else if (t.haltReason) status = 'Автораздача остановлена: нужна проверка сервера';
  else if (t.tournamentOver) status = 'Турнир завершён';
  else if (t.paused) status = idle ? 'Стол на паузе' : 'Пауза начнётся после выплаты банка';
  else if (t.nextHandAt !== null && t.nextHandAt !== undefined) status = `Следующая раздача через ${Math.max(0,Math.ceil((t.nextHandAt - Date.now() - clockOffset)/1000))} с`;
  else if (t.running) status = idle ? 'Ожидаем игроков для следующей раздачи' : 'Автораздача включена';
  if ($('auto-status').textContent !== status) $('auto-status').textContent = status;
  $('auto-status').hidden = !status;
  if(t.mode==='tournament'&&t.levelEndsAt!==null){const remaining=Math.max(0,t.levelEndsAt-(Date.now()+clockOffset));$('pending-changes').hidden=false;$('pending-changes').textContent=remaining===0?'Новый уровень со следующей раздачи':`Следующий уровень через ${Math.ceil(remaining/60000)} мин · смена с новой раздачи`;}
  const ms = t.rebuyReview ? (t.rebuyReview.deadlineRemaining||0) : t.deadline ? Math.max(0,t.deadline - (Date.now() + clockOffset)) : 0;
  $('time-counter').textContent = t.rebuyReview ? `Пауза · ${Math.ceil(ms/1000)} с` : t.deadline ? `${Math.ceil(ms/1000)} с` : '';
  $('timer-progress').style.width = `${Math.min(100,ms/t.turnMs*100)}%`;
}
setInterval(updateTimer,100);
function flyChip(from, to, delay = 0) {
  if (reducedMotion || !from || !to) return;
  const arena = $('arena'), root = arena.getBoundingClientRect(), a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const chip = document.createElement('i'); chip.className = 'flying-chip';
  chip.style.left = `${a.x+a.width/2-root.x-8}px`; chip.style.top = `${a.y+a.height/2-root.y-8}px`; arena.append(chip);
  const animation = chip.animate([{transform:'translate(0,0) scale(.8)',opacity:1},{transform:`translate(${b.x+b.width/2-a.x-a.width/2}px,${b.y+b.height/2-a.y-a.height/2}px) scale(1)`,opacity:.9}],{duration:470,easing:'cubic-bezier(.22,.7,.3,1)',delay,fill:'both'});
  animation.onfinish = () => chip.remove(); animation.oncancel = () => chip.remove();
}
function animateChanges(previous) {
  if (!state || reducedMotion) return;
  const t = state.table, old = previous?.table, newHand = !old || old.handId !== t.handId;
  if (newHand && t.handId) {
    const deck = $('deck').getBoundingClientRect();
    document.querySelectorAll('.seat-hand .playing-card').forEach((el,i) => {
      const rect = el.getBoundingClientRect(), final = getComputedStyle(el).transform;
      el.animate([{transform:`translate(${deck.x-rect.x}px,${deck.y-rect.y}px) rotate(-15deg) scale(.55)`,opacity:0},{transform:final,opacity:1}],{duration:380,delay:i*47,easing:'cubic-bezier(.2,.75,.2,1)',fill:'backwards'});
    });
    tone('deal');
  }
  const oldCount = newHand ? 0 : old?.board.length || 0;
  document.querySelectorAll('#board .playing-card').forEach((el,i) => {
    if (i >= oldCount) el.animate([{transform:'rotateY(90deg) translateY(-8px)',opacity:0},{transform:'rotateY(0deg) translateY(0)',opacity:1}],{duration:360,delay:(i-oldCount)*170,easing:'ease-out',fill:'backwards'});
  });
  if (old && old.handId === t.handId) {
    const lastId = old.history.at(-1)?.id || 0;
    t.history.filter(e => e.id > lastId && e.paid > 0).forEach(e => {
      const seat = [...document.querySelectorAll('.seat')].find(el => el.dataset.player === e.playerId);
      for (let j=0;j<3;j++) flyChip(seat,$('pot-display'),j*70);
      tone('chip');
    });
    if (t.phase === 'showdown' && old.phase !== 'showdown') {
      t.payouts.forEach(p => {
        const seat = [...document.querySelectorAll('.seat')].find(el => el.dataset.player === p.id);
        for (let j=0;j<4;j++) flyChip($('pot-display'),seat,500+j*65);
      }); tone('win');
    }
  }
  if (t.actor === state.me && old?.actor !== state.me) {
    try { if (telegram()?.isVersionAtLeast('6.1')) telegram().HapticFeedback.notificationOccurred('success'); } catch {}
  }
}
async function send(action,data = {}) {
  if (!transport || busy || !connected) return false;
  busy = true; updateActions();
  try { return await transport.send(action,data) || {ok:true}; }
  catch (e) { toast(e.message || 'Нет связи с сервером'); return false; }
  finally { busy = false; updateActions();if(rebuyReviewOpen)renderRebuyDialog(); }
}
function move(name, amount = null) {
  if (!state?.table.legal) return;
  raiseOpen = false;
  send('act',{move:name,amount,handId:state.table.handId,version:state.table.version});
}
function extractInvite(value) {
  const trimmed = String(value || '').trim();
  if (/^r[0-9a-f]{12}_[A-Za-z0-9_-]{24,36}$/.test(trimmed) || /^[A-HJ-NP-Z2-9]{8}$/i.test(trimmed)) return trimmed;
  try { const url = new URL(trimmed); return url.searchParams.get('startapp') || url.searchParams.get('room') || ''; } catch { return ''; }
}
const presetMinutes={Hyper:3,Turbo:5,Normal:10,Deep:20};
function levelRows(preset='Normal') {
  const pairs=[[25,50],[50,100],[75,150],[100,200],[150,300],[200,400],[300,600],[400,800],[600,1200],[1000,2000]];
  return pairs.map(([sb,bb],i)=>`<tr><td>${i+1}</td><td><input aria-label="SB уровня ${i+1}" type="number" min="1" value="${sb}" data-level="smallBlind" required></td><td><input aria-label="BB уровня ${i+1}" type="number" min="2" value="${bb}" data-level="bigBlind" required></td><td><input aria-label="Минут уровня ${i+1}" type="number" min="1" max="120" value="${presetMinutes[preset]||10}" data-level="durationMinutes" required></td></tr>`).join('');
}
function createDialog() {
 if(standalone)return startDemo();
 modal(`<h2>Соберём своих</h2><p>Только условные фишки. Каждый гость входит с вашего подтверждения.</p><form id="create-form">
 ${!user?'<label for="player-name">Ваше имя</label><input id="player-name" name="playerName" value="Игрок" maxlength="32" required>':''}
 <label for="new-room-name">Название стола</label><input id="new-room-name" name="name" value="Свои за столом" maxlength="50" required>
 <label for="game-mode">Формат</label><select id="game-mode" name="mode"><option value="cash">Cash · условные фишки</option><option value="tournament">Tournament · с закупами</option></select>
 <div id="cash-options"><div class="form-row"><div><label for="small-blind">SB</label><input id="small-blind" name="smallBlind" type="number" min="1" max="5000" value="10" required></div><div><label for="big-blind">BB</label><input id="big-blind" name="bigBlind" type="number" min="2" max="10000" value="20" required></div></div>
 <label for="buy-in-mode">Buy-in</label><select id="buy-in-mode" name="buyInMode"><option value="fixed">Фиксированный</option><option value="range">Диапазон min / max</option></select>
 <div class="form-row" id="buy-in-range" hidden><div><label for="min-buy">Минимум</label><input id="min-buy" name="minBuyIn" type="number" min="40" value="2000"></div><div><label for="max-buy">Максимум</label><input id="max-buy" name="maxBuyIn" type="number" min="40" value="6000"></div></div>
 <p class="form-note">Докупка во время игры — по подтверждению администратора, без лимита buy-in.</p>
 <label class="check-setting"><input type="checkbox" name="straddleAllowed" id="allow-straddle"> Добровольный UTG-страдл 2 BB</label></div>
 <div id="tournament-options" hidden><label for="tournament-preset">Структура</label><select id="tournament-preset" name="preset">${['Hyper','Turbo','Normal','Deep','Custom'].map(n=>`<option ${n==='Normal'?'selected':''}>${n}</option>`).join('')}</select><p class="form-note">Уровень меняется только с новой раздачи. Последний уровень действует до конца турнира.</p><table class="levels-editor"><thead><tr><th>№</th><th>SB</th><th>BB</th><th>Мин.</th></tr></thead><tbody id="levels-body">${levelRows()}</tbody></table><button type="button" class="text-button" id="add-level">+ Уровень</button><button type="button" class="text-button" id="remove-level">− Последний уровень</button></div>
 <div class="form-row"><div><label for="starting-stack">Стартовый стек</label><input type="number" id="starting-stack" name="startingStack" min="40" max="1000000000000000" value="2000" required></div><div><label for="turn-seconds">Секунд на ход</label><input type="number" id="turn-seconds" name="turnSeconds" min="10" max="120" value="30" required></div></div>
 <label for="max-players">Максимум игроков</label><select id="max-players" name="maxPlayers">${[2,3,4,5,6].map(n=>`<option ${n===6?'selected':''}>${n}</option>`).join('')}</select>
 <button class="button primary" type="submit">Создать приватный стол →</button><p class="form-note">Фишки бесплатны и не обмениваются на деньги, товары или услуги.</p></form>`);
}

function joinDialog(code = '') {
  if (standalone) { modal('<h2>Друзья — в полной версии</h2><p>Этот HTML-файл — автономное демо с ботами. Приватные комнаты работают при запуске сервера из архива проекта.</p><button class="button primary" id="modal-demo">Попробовать демо</button>'); return; }
  modal(`<h2>Вход по приглашению</h2><p>Вставьте ссылку от хозяина стола. Он увидит вашу заявку и сможет посадить вас за стол.</p><form id="join-form">${!user?'<label for="join-name">Ваше имя</label><input id="join-name" name="playerName" value="Друг" maxlength="32" required>':''}<label for="invite-link">Ссылка или код</label><input id="invite-link" name="code" value="${escapeHTML(code)}" placeholder="Приглашение в приватную комнату" required autocomplete="off"><label for="join-buy-in">Желаемый стек · необязательно</label><input id="join-buy-in" name="buyIn" type="number" min="1" placeholder="По настройкам хозяина"><button class="button primary" type="submit">Попроситься за стол <span>→</span></button></form>`);
}
function inviteDialog() {
  if (!state?.room.invite) return;
  modal(`<h2>Место для своих</h2><p>Отправьте ссылку друзьям. Даже с приглашением они не увидят игру, пока вы не подтвердите вход.</p><p>Код комнаты: <strong>${escapeHTML(state.room.code||"—")}</strong></p><label for="share-link">Приватное приглашение · действует 8 часов после создания или обновления</label><textarea id="share-link" readonly>${escapeHTML(state.room.invite)}</textarea><button id="copy-invite" class="button primary">Скопировать приглашение</button><button id="share-telegram" class="button secondary">Отправить в Telegram</button><p class="form-note">Ссылку можно отозвать в настройках комнаты.</p>`);
}
function straddleControl() {
  const t=state.table,p=t.players.find(p=>p.id===state.me),idle=['waiting','showdown'].includes(t.phase);
  if(t.mode !== 'cash' || !t.straddleAllowed) return '<p class="form-note">Страдл за этим столом запрещён.</p>';
  return `<button class="button secondary" id="straddle-preference" ${!idle?'disabled':''}>Автострадл UTG 2 BB: ${p?.autoStraddle?'включён':'выключен'}</button><p class="form-note">Личное согласие на страдл. Меняется только между раздачами. Ставка ставится только на UTG при 3+ игроках и достаточном стеке; не является обязательной.</p>`;
}
function requestRebuyDialog() {
  if(!state || state.demo)return;
  const mine=state.table.players.find(p=>p.id===state.me);
  const pending=state.table.rebuyRequests?.find(r=>r.playerId===state.me);
  modal(`<h2>Запрос закупа</h2>${pending?`<p>Запрос на <strong>${fmt(pending.amount)}</strong> фишек ожидает администратора.</p><button class="button secondary" data-cancel-rebuy="${escapeHTML(pending.id)}">Отменить запрос</button>`:`<form id="rebuy-form"><label for="funding-type">Вид закупа</label><select id="funding-type" name="fundingType">${!mine?.fundedBefore?'<option value="buyIn">Бай-ин · первый вход</option>':'<option value="rebuy">Ребай · докупка</option><option value="addon">Аддон</option><option value="reentry">Реэнтри · после выбывания</option>'}</select><label for="rebuy-amount">Сколько фишек добавить</label><input id="rebuy-amount" name="amount" type="text" inputmode="numeric" maxlength="20" value="${state.table.startingStack}" autocomplete="off" required><button class="button primary" type="submit">Отправить администратору</button></form>`}<p class="form-note">Текущий стек: ${fmt(mine?.stack)}.${mine?.pendingBuyIn?` Уже подтверждено на следующую раздачу: ${fmt(mine.pendingBuyIn)}.`:''} Фишки, подтверждённые во время руки, вступают в игру со следующей раздачи и не меняют текущий олл-ин.</p>`);
}
async function openRebuyReview() {
  if(rebuyReviewOpen)return;
  const result=await send('beginRebuyReview');
  if(!result)return;
  rebuyReviewId=result.reviewId || state?.table.rebuyReview?.id;
  if(!rebuyReviewId || state?.table.rebuyReview?.id!==rebuyReviewId){rebuyReviewId=null;toast('Пауза уже завершилась. Откройте запросы ещё раз.');return;}
  rebuyReviewOpen=true;$('rebuy-notice').hidden=true;renderRebuyDialog();
}
const fundingLabel=type=>({buyIn:'Бай-ин',rebuy:'Ребай',reentry:'Реэнтри',addon:'Аддон'}[type]||'Закуп');
function fundingRequests(){return [...(state.table.rebuyRequests||[]),...(state.room.pending||[]).map(p=>({...p,amount:p.buyIn,fundingType:'buyIn',admission:true}))];}
function renderRebuyDialog() {
  if(!rebuyReviewOpen || !state)return;
  const requests=fundingRequests();
  modal(`<h2>Закуп в игре</h2><p>Игра и таймер приостановлены. После закрытия окна ход продолжится с оставшимся временем.</p><div class="rebuy-queue">${requests.length?requests.map(r=>`<section class="rebuy-request"><strong>${escapeHTML(r.name)}</strong><p>${fundingLabel(r.fundingType)} · <b>${fmt(r.amount)}</b> фишек</p><div class="rebuy-decisions"><button class="button primary" ${r.admission?'data-approve-admission':'data-approve-rebuy'}="${escapeHTML(r.id)}" ${busy||!connected?'disabled':''}>Подтвердить</button><button class="button secondary" ${r.admission?'data-deny-admission':'data-deny-rebuy'}="${escapeHTML(r.id)}" ${busy||!connected?'disabled':''}>Отклонить</button></div></section>`).join(''):'<p>Все запросы обработаны.</p>'}</div><button id="end-rebuy-review" class="button secondary" ${rebuyClosing?'disabled':''}>Закрыть и продолжить игру</button><p class="form-note">При потере связи с администратором пауза снимается автоматически в течение 2 минут. Необработанные запросы сохраняются.</p>`);
}
function renderRebuys(previous) {
  const {table:t,room:r,me}=state,requests=fundingRequests();
  $('rebuy-notice').hidden=r.ownerId!==me||!requests.length||rebuyReviewOpen||!!state.demo;
  $('rebuy-notice-names').textContent=requests.map(q=>`${q.name}: ${fmt(q.amount)}`).join(' · ');
  $('rebuy-banner').hidden=!t.rebuyReview;
  $('rebuy-banner').textContent=t.rebuyReview?`Закуп в игре · ${requests.length?requests.map(q=>q.name).join(', '):(t.rebuyReview.names||[]).join(', ')||'запросы обработаны'} · игра на паузе`:'';
  const own=t.players.find(p=>p.id===me);
  $('rebuy-pending-credit').hidden=!own?.pendingBuyIn;
  $('rebuy-pending-credit').textContent=own?.pendingBuyIn?`${fmt(own.pendingBuyIn)} фишек подтверждено — со следующей раздачи`:'';
  if(rebuyReviewOpen){
    if(!t.rebuyReview || t.rebuyReview.id!==rebuyReviewId){rebuyReviewOpen=false;rebuyReviewId=null;$('modal').close();}
    else renderRebuyDialog();
  }
  if(previous){const last=previous.table.history.at(-1)?.id||0;const approved=t.history.filter(e=>e.id>last&&e.kind==='rebuyApproved');if(approved.length)toast(approved.map(e=>e.text).join(' · '));}
}
setInterval(async()=>{
  if(!rebuyReviewOpen||!rebuyReviewId||!connected||document.hidden||!transport||busy)return;
  try{await api('/api/command',{roomId:state.room.id,requestId:crypto.randomUUID(),action:'renewRebuyReview',reviewId:rebuyReviewId});}catch{}
},20000);
function settingsDialog() {
  if (!state) return;
  const {room:r,table:t,me} = state, isOwner = r.ownerId === me, idle = ['waiting','showdown'].includes(t.phase);
  if (state.demo) {
    modal(`<h2>Пробная игра · 0.3</h2><p>Локальное демо с ботами, не защищённая онлайн-комната. Формат: ${t.mode==='tournament'?'турнир-фризаут':'кэш на условные фишки'}.</p>${straddleControl()}<button class="button primary" id="reset-demo">Новое кэш-демо</button><button class="button secondary" id="tournament-demo">Новое турнирное демо</button><button class="button secondary" id="modal-home">На главную</button>`); return;
  }
  const mayRemove=idle&&(t.mode!=='tournament'||!t.handId||t.tournamentOver);
  modal(`<h2>Ваш стол</h2><p>${escapeHTML(r.name)} · ${t.mode==='tournament'?'Турнир без анте':'Кэш'} · ${fmt(t.smallBlind)} / ${fmt(t.bigBlind)}</p>${straddleControl()}<button class="button secondary" id="modal-request-rebuy">Запросить закуп</button><p class="form-note">Любая выдача фишек, включая первый вход хозяина, требует подтверждения администратора.</p>${isOwner&&t.mode==='cash'?`<form id="blinds-form"><h3>Блайнды со следующей раздачи</h3><div class="form-row"><input aria-label="Новый SB" name="smallBlind" type="number" min="1" value="${t.smallBlind}" required><input aria-label="Новый BB" name="bigBlind" type="number" min="2" value="${t.bigBlind}" required></div><button type="submit" class="button secondary">Сохранить блайнды</button></form>`:''}${isOwner?`<div class="modal-setting-row"><span>Новые заявки: ${r.locked?'закрыты':'открыты'}</span><button class="button secondary small" id="toggle-lock">${r.locked?'Открыть':'Закрыть вход'}</button></div><button class="button secondary" id="rotate-invite">Отозвать ссылку и создать новую</button><div class="modal-players">${t.players.filter(p=>p.id!==me).map(p=>`<div class="modal-player"><span>${escapeHTML(p.name)}</span><button data-kick="${escapeHTML(p.id)}" ${!mayRemove?'disabled':''}>Убрать со стола</button></div>`).join('')}</div><button class="button secondary danger-button" id="close-room" ${!mayRemove?'disabled':''}>Закрыть стол для всех</button>`:`<button class="button secondary" id="leave-room" ${!mayRemove?'disabled':''}>Покинуть стол</button>`}<p class="form-note">По таймеру — пас и статус «Не играю», даже при доступном чеке. В турнире блайнды продолжают списываться; в кэше после пропущенных рук возвращаются на BB. Бай-ин, ребай, аддон и реэнтри подтверждает администратор. Реэнтри доступен после полного выбывания; для остальных докупок выберите ребай. Поздний вход возможен при свободном месте. Подтверждённый закуп может продолжить завершившийся турнир.</p>`);
}
function settlementDialog() {
  if (!state) return;
  const t=state.table.phase === 'showdown' ? state.table : state.table.lastHand;
  if (!t) return;
  inspectedHand = structuredClone(t);
  const name=id=>escapeHTML(t.players.find(p=>p.id===id)?.name||id);
  modal(`<h2>Разбор раздачи #${t.handId}</h2><p class="form-note">Игра продолжается автоматически. Для долгого разбора хозяин может поставить стол на паузу.</p><p>Внесено: <strong>${fmt(t.committedPot)}</strong>. Выплаты из банков: <strong>${fmt(t.lastPot)}</strong>. Возвраты: <strong>${fmt(t.refunds.reduce((s,r)=>s+r.amount,0))}</strong>.</p>${t.pots.map(p=>`<section class="settlement-pot"><h3>${escapeHTML(p.label)} <span>${fmt(p.amount)}</span></h3><p>Право на банк: ${p.eligible.map(name).join(', ')}.</p>${p.awards.map(a=>`<div class="settlement-row"><span>${name(a.id)}</span><strong>получает ${fmt(a.amount)}</strong></div>`).join('')}</section>`).join('')}${t.refunds.length?`<section class="settlement-pot"><h3>Возврат непокрытых ставок</h3>${t.refunds.map(r=>`<div class="settlement-row"><span>${name(r.id)}</span><strong>${fmt(r.amount)}</strong></div>`).join('')}<p>Это собственные фишки игрока, не выигрыш.</p></section>`:''}<h3>Итог каждого игрока</h3>${t.accounting.map(p=>`<section class="settlement-player"><div class="settlement-row"><strong>${escapeHTML(p.name)}</strong><strong>${signed(p.net)}</strong></div><p>Внесено ${fmt(p.contributed)} · из банков ${fmt(p.won)} · возврат ${fmt(p.returned)}<br>Стек: ${fmt(p.startStack)} → ${fmt(p.finalStack)}</p></section>`).join('')}<div class="state-note">Выплата из банка ≠ чистый выигрыш. Итог = выплаты + возврат − взносы. Сумма итогов всех игроков: ${fmt(t.accounting.reduce((s,p)=>s+p.net,0))}.</div><button class="button secondary" id="export-hand">Сохранить отчёт этой раздачи</button><p class="form-note">Отчёт содержит ваши карты и карты, открытые на вскрытии. Чужие сброшенные карты, колода и токены не включаются.</p>`);
}
function exportHand(fromModal = false) {
  if(!state?.table.handId)return;
  const t=fromModal === true && inspectedHand ? inspectedHand : state.table.lastHand || state.table;
  const report={appVersion:'0.4.2',reportType:state.demo?'untrusted-local-demo':'client-visible-snapshot',
    roomId:state.room.id,handId:t.handId,rulesVersion:t.rulesVersion,mode:t.mode,phase:t.phase,
    me:state.me,board:t.board,players:t.players,pots:t.pots,refunds:t.refunds,
    accounting:t.accounting,events:t.handHistory,historyTruncated:t.historyTruncated};
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`svoi-hand-${t.handId}.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('Отчёт сохранён. Это снимок клиента, не независимое доказательство честности.');
}
function rulesDialog() {
  modal('<h2>Правила стола · 0.3</h2><p>Безлимитный техасский холдем, 2–6 мест. Лучшая пятёрка из семи карт; можно использовать 0, 1 или 2 свои карты. Сравниваются также кикеры, масть не даёт преимущества.</p><p><strong>Банки:</strong> при разных олл-инах каждый банк получает своих участников и победителей. Сброшенные ставки остаются в банке, но их владельцы не выигрывают. Непокрытая часть ставки возвращается. При равенстве остаточная фишка идёт первому победителю слева от баттона, отдельно для каждого настоящего банка.</p><p><strong>Ставки:</strong> «повысить до» означает итоговую ставку на улице. Минимальное повышение равно последней полной ставке или полному повышению. Короткий олл-ин сам по себе не открывает повторное повышение; совокупность коротких олл-инов проверяется отдельно для каждого игрока.</p><p><strong>Кэш:</strong> фиксированные блайнды. По настройке стола — один добровольный живой UTG-страдл 2 BB, согласованный до карт. Минимальный префлоп-рейз при страдле — до 4 BB; после флопа минимальная ставка снова 1 BB. Нет баттон-страдлов, рестрадлов и страдла в heads-up.</p><p><strong>Любой закуп:</strong> запрос доступен в любой момент. Администратор открывает окно запросов — текущая раздача и её таймер замирают. Подтверждённые фишки во время руки добавляются только после расчёта банка, для следующей раздачи. Закрытие окна продолжает оставшееся время хода.</p><p><strong>Турнир:</strong> одностоловый турнир без анте и страдла; поздний вход, ребай и реэнтри — только с подтверждением администратора. Блайнды удваиваются через выбранный интервал только со следующей раздачи; максимум 21 уровень. Используется мёртвый баттон при выбывании. Побеждает последний игрок с фишками.</p><p>Хозяин запускает игру один раз. Следующая раздача начинается автоматически через 6 секунд после выплаты. По таймеру — пас и «Не играю», даже при бесплатном чеке: это выбранное правило онлайн-стола, а не правило таймера живого TDA. Уже сделанный олл-ин не сбрасывается. Кнопка «Я вернулся» действует только на будущую раздачу; после пропуска рук в кэше нужно дождаться BB. В турнире блайнды продолжают списываться. Пауза хозяина применяется между руками, не прерывает раздачу и замораживает турнирные уровни только на время самой паузы.</p><div class="state-note">Условные фишки. Это тестовая сборка, не сертифицированный покер-рум. В демо вся игра находится в браузере. Разбор последней завершённой раздачи доступен и во время следующей; сохраняйте отчёт, пока она не закончится.</div>');
}
$('create-room').addEventListener('click',createDialog);
$('join-room').addEventListener('click',()=>joinDialog());
$('try-demo').addEventListener('click',startDemo);
$('resume-room').addEventListener('click',()=>{ if(storage.get('room')) openRoom(storage.get('room')); });
$('brand-home').addEventListener('click',()=> {
  if (state && !['waiting','showdown'].includes(state.table.phase) && !confirm('Выйти из экрана игры? Таймер продолжит идти; по таймеру будет пас и статус «Не играю».')) return;
  home();
});
$('cancel-wait').addEventListener('click',home);
$('close-modal').addEventListener('click',closeModal);
$('modal').addEventListener('click',e=>{if(e.target === $('modal')) closeModal();});
$('invite-button').addEventListener('click',inviteDialog);
$('room-settings').addEventListener('click',settingsDialog);
$('rules-button').addEventListener('click',rulesDialog);
$('settlement-button').addEventListener('click',settlementDialog);
$('hand-report-button').addEventListener('click',exportHand);
$('start-hand').addEventListener('click',()=>send('start'));
$('participation-button').addEventListener('click',()=>{
  const p=state?.table.players.find(p=>p.id===state.me);
  if(p) send(p.sittingOut && !p.returnPending ? 'returnToPlay' : 'sitOut');
});
$('pause-table').addEventListener('click',()=>send('pause',{paused:!state.table.paused}));
$('top-up').addEventListener('click',()=>state?.demo?send('topUp'):requestRebuyDialog());
$('request-rebuy').addEventListener('click',requestRebuyDialog);
$('open-rebuy-requests').addEventListener('click',openRebuyReview);
$('modal').addEventListener('cancel',e=>{if(rebuyReviewOpen){e.preventDefault();closeModal();}});
$('fold').addEventListener('click',()=>move('fold'));
$('check-call').addEventListener('click',()=>move(state.table.legal.toCall?'call':'check'));
$('raise-toggle').addEventListener('click',()=>{raiseOpen=!raiseOpen;updateActions();});
$('confirm-raise').addEventListener('click',()=>move('raise',Number($('raise-amount').value)));
$('raise-range').addEventListener('input',()=>{$('raise-amount').value=$('raise-range').value;updateActions();});
$('raise-amount').addEventListener('input',()=>{const value=Number($('raise-amount').value);$('raise-range').value=value;$('confirm-raise').textContent=`До ${fmt(value)}`;});
$('raise-amount').addEventListener('change',updateActions);
document.querySelector('.presets').addEventListener('click',e=>{
  const preset=e.target.closest('[data-preset]')?.dataset.preset;if(!preset || !state?.table.legal) return;
  const t=state.table,l=t.legal,p=t.players.find(p=>p.id===state.me);
  const value=preset==='all'?l.maxTo:p.bet+l.toCall+Math.floor((t.pot+l.toCall)*(preset==='half'?.5:preset==='two-thirds'?2/3:1));
  $('raise-amount').value=Math.max(Math.min(l.minTo,l.maxTo),Math.min(l.maxTo,value));updateActions();
});
$('pending-requests').addEventListener('click',e=>{
  const accept=e.target.closest('[data-approve]'),deny=e.target.closest('[data-deny]');
  if(accept && !accept.disabled) send('approve',{userId:accept.dataset.approve});
  if(deny) send('deny',{userId:deny.dataset.deny});
});
$('modal-content').addEventListener('change',e=>{
 if(e.target.id==='game-mode'){const tournament=e.target.value==='tournament';$('cash-options').hidden=tournament;$('tournament-options').hidden=!tournament;$('allow-straddle').disabled=tournament;if(tournament){$('allow-straddle').checked=false;$('starting-stack').value=10000;}}
 if(e.target.id==='buy-in-mode')$('buy-in-range').hidden=e.target.value!=='range';
 if(e.target.id==='tournament-preset'&&e.target.value!=='Custom')$('levels-body').innerHTML=levelRows(e.target.value);
 if(e.target.dataset.level)$('tournament-preset').value='Custom';
});
$('modal-content').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target, data=Object.fromEntries(new FormData(form)), button=form.querySelector('button[type=submit]');
  if(!button) return;button.disabled=true;
  try {
    if(form.id==='blinds-form'){await send('blinds',{smallBlind:Number(data.smallBlind),bigBlind:Number(data.bigBlind)});closeModal();return;}
    if(form.id==='rebuy-form'){const raw=String(data.amount||'').replace(/\s/g,'');if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<1)throw new Error('Введите целое положительное число фишек');const result=await send('requestRebuy',{amount:Number(raw),fundingType:data.fundingType});if(result){await closeModal();toast('Запрос отправлен администратору');}return;}
    await login(data.playerName || 'Игрок');
    let result;
    if(form.id==='create-form') {
     const levels=data.mode==='tournament'?[...$('levels-body').rows].map(row=>Object.fromEntries([...row.querySelectorAll('input')].map(i=>[i.dataset.level,Number(i.value)]))):null;
     result=await api('/api/rooms',{name:data.name,smallBlind:levels?.[0].smallBlind??Number(data.smallBlind),bigBlind:levels?.[0].bigBlind??Number(data.bigBlind),startingStack:Number(data.startingStack),turnSeconds:Number(data.turnSeconds),mode:data.mode,straddleAllowed:data.mode==='cash'&&data.straddleAllowed==='on',maxPlayers:Number(data.maxPlayers),buyInMode:data.mode==='cash'?data.buyInMode:'fixed',minBuyIn:Number(data.minBuyIn),maxBuyIn:Number(data.maxBuyIn),rebuyAllowed:true,levels});
    }
    else if(form.id==='join-form') {const code=extractInvite(data.code);if(!code) throw new Error('Нужна полная ссылка-приглашение или код комнаты');result=await api('/api/join',{code,...(data.buyIn?{buyIn:Number(data.buyIn)}:{})});}
    if(result) {closeModal();openRoom(result.roomId);}
  } catch(err) {toast(err.message);} finally {button.disabled=false;}
});
$('modal-content').addEventListener('click',async e=>{
  const button=e.target.closest('button');if(!button || button.disabled) return;
  try {
    if(button.id==='modal-request-rebuy'){requestRebuyDialog();return;}
    if(button.id==='end-rebuy-review'){await closeModal();return;}
    if(button.dataset.approveAdmission){await send('approve',{userId:button.dataset.approveAdmission});return;}
    if(button.dataset.denyAdmission){await send('deny',{userId:button.dataset.denyAdmission});return;}
    if(button.dataset.approveRebuy){await send('approveRebuy',{rebuyRequestId:button.dataset.approveRebuy});return;}
    if(button.dataset.denyRebuy){await send('denyRebuy',{rebuyRequestId:button.dataset.denyRebuy});return;}
    if(button.dataset.cancelRebuy){const result=await send('cancelRebuy',{rebuyRequestId:button.dataset.cancelRebuy});if(result)await closeModal();return;}
    if(button.id==='add-level'){const rows=$('levels-body');if(rows.rows.length<50){const row=rows.rows[rows.rows.length-1].cloneNode(true);row.cells[0].textContent=rows.rows.length+1;rows.append(row);$('tournament-preset').value='Custom';}return;}
    if(button.id==='remove-level'){if($('levels-body').rows.length>1)$('levels-body').lastElementChild.remove();$('tournament-preset').value='Custom';return;}
    if(['reset-demo','modal-demo'].includes(button.id)) startDemo();
    else if(button.id==='tournament-demo') startDemo('tournament');
    else if(button.id==='export-hand') exportHand(true);
    else if(button.id==='straddle-preference') {const p=state.table.players.find(p=>p.id===state.me);closeModal();await send('straddle',{enabled:!p.autoStraddle});}
    else if(button.id==='modal-home') home();
    else if(button.id==='copy-invite') {
      try {await navigator.clipboard.writeText($('share-link').value);toast('Приглашение скопировано');}
      catch {$('share-link').focus();$('share-link').select();toast('Скопируйте выделенную ссылку');}
    } else if(button.id==='share-telegram') {
      const url=`https://t.me/share/url?url=${encodeURIComponent(state.room.invite)}&text=${encodeURIComponent('Собираемся в СВОИ. Присоединяйся к нашему столу ♠')}`;
      if(telegram()?.initData) telegram().openTelegramLink(url);else window.open(url,'_blank','noopener,noreferrer');
    } else if(button.id==='toggle-lock') {closeModal();await send('lock');}
    else if(button.id==='rotate-invite') {closeModal();await send('rotateInvite');}
    else if(button.dataset.kick) {closeModal();await send('kick',{userId:button.dataset.kick});}
    else if(button.id==='leave-room') {closeModal();await send('leave');}
    else if(button.id==='close-room' && confirm('Закрыть комнату для всех игроков?')) {closeModal();await send('close');}
  } catch(err) {toast(err.message);}
});
$('sound-toggle').addEventListener('click',async ()=>{
  try {
    if(!audio) audio=new (window.AudioContext || window.webkitAudioContext)();
    await audio.resume();sound=!sound;$('sound-toggle').querySelector('.sound-slash').hidden=sound;
    $('sound-toggle').setAttribute('aria-label',sound?'Выключить звук':'Включить звук');$('sound-toggle').title=sound?'Звук включён':'Звук выключен';tone('deal');
  } catch {toast('Звук недоступен в этом браузере');}
});
$('fullscreen').addEventListener('click',async ()=>{
  try { const tg=telegram();if(tg?.initData&&tg.isVersionAtLeast('8.0')) tg.isFullscreen?tg.exitFullscreen():tg.requestFullscreen();else if(document.fullscreenElement) await document.exitFullscreen();else if(document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();else toast('Полный экран доступен внутри Telegram'); }
  catch {toast('Не удалось включить полный экран');}
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden && state && !state.demo) api(`/api/room?room=${state.room.id}`).then(handlePacket).catch(()=>{});});
async function init() {
  if(standalone) {$('create-room').innerHTML='Начать демо <span>→</span>';$('join-room').textContent='Как играть с друзьями';return;}
  try {
    const tg=telegram();
    if(tg?.initData) {tg.ready();tg.expand();if(tg.isVersionAtLeast('6.1')) {tg.setHeaderColor('#101917');tg.setBackgroundColor('#101917');}if(tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes();}
    const deployment=await fetch('/config.json',{cache:'no-store'}).then(r=>r.json()).catch(()=>({}));
    if(deployment.supabaseUrl){config={...deployment,authMode:'guest'};const {cloudClient}=await import('./cloud.mjs');cloud=cloudClient(config);const {data}=await cloud.auth.getSession();if(data.session){token=data.session.access_token;user={id:data.session.user.id,name:data.session.user.user_metadata?.name||'Игрок'};}}
    else config=await api('/api/config');
    if(tg?.initData) {user=null;await login();}
    else if(token) {try {const data=await api('/api/me');user=data.user;}catch {token=null;storage.set('token',null);}}
    const params=new URLSearchParams(location.search);
    const code=extractInvite(params.get('room') || params.get('tgWebAppStartParam') || tg?.initDataUnsafe?.start_param || '');
    // A start parameter is only an invitation token; the server still verifies
    // Telegram identity, token expiry and explicit owner approval.
    if(code) {joinDialog(code);if(user) {const result=await api('/api/join',{code});closeModal();openRoom(result.roomId);}}
    else if(user && storage.get('room')) openRoom(storage.get('room'));
    updateResume();
  } catch(e) {toast(e.message || 'Сервер недоступен. Можно попробовать локальное демо.');}
}
init();

if('serviceWorker' in navigator && !standalone) navigator.serviceWorker.register('/sw.js').catch(()=>{});
